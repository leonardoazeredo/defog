package codes.madera.crossfog.watchlink

import android.util.Log
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class WatchLinkModule : Module() {
  private val context by lazy {
    appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "no Android context", null)
  }
  private val keys by lazy { Keys(context) }

  // Both stores live in noBackupFilesDir for the same reason as the database key: a restored copy
  // would be undecryptable.
  private val staging by lazy {
    StagingStore(File(context.noBackupFilesDir, "staging"), keys.stagingKey(), ::fsyncDirectory)
  }
  private val outbox by lazy {
    StagingStore(File(context.noBackupFilesDir, "outbox"), keys.stagingKey(), ::fsyncDirectory)
  }

  private val saveAs by lazy { SaveAs(context.contentResolver, context.cacheDir) }
  private lateinit var createLauncher: AppContextActivityResultLauncher<CreateInput, Uri?>

  override fun definition() = ModuleDefinition {
    Name("WatchLink")

    Events("activityStaged", "linkStatus", "routeSaved")

    AsyncFunction("getDatabaseKeyHex") {
      try {
        keys.databaseKey().toHex()
      } catch (e: KeyLostException) {
        throw CodedException(KEY_LOST, e.message, e)
      }
    }

    // Only for a restore from the lost state, where the old database cannot be read by any key; JS
    // calls it once the database built with this key is in place.
    AsyncFunction("replaceLostDatabaseKey") { keyHex: String ->
      val dek = databaseKeyFromHex(keyHex)
      try {
        keys.replaceLostDatabaseKey(dek)
      } catch (e: IllegalStateException) {
        throw CodedException(INVALID_STATE, e.message, e)
      } finally {
        dek.fill(0)
      }
    }

    RegisterActivityContracts {
      createLauncher = registerForActivityResult(CreateDocumentContract())
    }

    AsyncFunction("createDocument") Coroutine { name: String, mime: String ->
      createLauncher.launch(CreateInput(name, mime))?.toString()
    }

    AsyncFunction("copyToUri") Coroutine { sourcePath: String, uri: String ->
      withContext(Dispatchers.IO) { saveAs.copyToUri(sourcePath, Uri.parse(uri)).toDouble() }
    }

    AsyncFunction("displayNameOf") Coroutine { uri: String ->
      withContext(Dispatchers.IO) { saveAs.displayName(Uri.parse(uri)) }
    }

    AsyncFunction("copyFromUri") Coroutine { uri: String, destPath: String ->
      withContext(Dispatchers.IO) {
        val r = saveAs.copyFromUri(Uri.parse(uri), destPath)
        mapOf("size" to r.size.toDouble(), "head" to r.head.toHex())
      }
    }

    AsyncFunction("keyState") { keys.keyState().wire }

    // The watch transport is not built yet, so the link is never paired and never reachable.
    AsyncFunction("status") { mapOf("paired" to false, "reachable" to false) }

    AsyncFunction("pendingActivities") {
      staging.list().mapNotNull { id -> summaryOf(id) }
    }

    AsyncFunction("readActivity") { id: String ->
      val bytes = coded { staging.read(id) }
        ?: throw CodedException(NOT_FOUND, "no staged activity with that id", null)
      String(bytes, Charsets.UTF_8)
    }

    AsyncFunction("release") { id: String -> coded { staging.release(id) } }

    AsyncFunction("queueRoute") { routeJson: String ->
      coded {
        val bytes = routeJson.toByteArray(Charsets.UTF_8)
        outbox.stage(Frames.parseRouteOffer(bytes).routeId, bytes)
      }
    }

    debugFunctions { bytes -> coded { stageActivity(bytes) } }
  }

  /** The one way an activity enters the staging store; the event follows the durable write. */
  private fun stageActivity(bytes: ByteArray) {
    val offer = Frames.parseActivityOffer(bytes)
    staging.stage(offer.activityId, bytes)
    // sendEvent is a no-op while no JS runtime is attached; JS then finds the item through pendingActivities on start.
    sendEvent("activityStaged", mapOf("activityId" to offer.activityId))
  }

  private fun summaryOf(id: String): Map<String, Any?>? {
    // An item that cannot be read, parsed or matched to its file name is skipped so it does not hide
    // the others. A key failure is not caught here, so it propagates to the caller.
    val offer = try {
      staging.read(id)?.let { Frames.parseActivityOffer(it) }?.takeIf { it.activityId == id }
    } catch (e: FrameException) {
      null
    } catch (e: IOException) {
      null
    }
    // A staged item that no longer authenticates or parses is skipped, not deleted: it is the only
    // copy the watch has already given up. Nothing of it is logged.
    if (offer == null) Log.w(TAG, "skipping an unreadable staged item")
    return offer?.summary()
  }

  private inline fun <T> coded(block: () -> T): T =
    try {
      block()
    } catch (e: FrameException) {
      throw CodedException(INVALID_FRAME, e.message, e)
    } catch (e: IllegalArgumentException) {
      throw CodedException(INVALID_ID, e.message, e)
    }

  private companion object {
    const val TAG = "WatchLink"
    const val KEY_LOST = "ERR_KEY_LOST"
    const val NOT_FOUND = "ERR_NOT_FOUND"
    const val INVALID_FRAME = "ERR_INVALID_FRAME"
    const val INVALID_ID = "ERR_INVALID_ID"
    const val INVALID_STATE = "ERR_INVALID_STATE"
  }
}

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

// The message never repeats the text: it is key material.
internal fun databaseKeyFromHex(hex: String): ByteArray {
  require(hex.length == 64 && hex.all { it in '0'..'9' || it in 'a'..'f' }) {
    "malformed database key"
  }
  return ByteArray(32) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
}
