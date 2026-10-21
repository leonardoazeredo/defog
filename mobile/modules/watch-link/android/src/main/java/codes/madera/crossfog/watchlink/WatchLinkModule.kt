package codes.madera.crossfog.watchlink

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

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
    val bytes = staging.read(id)
    val offer = try {
      bytes?.let { Frames.parseActivityOffer(it) }
    } catch (e: FrameException) {
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
  }
}

internal fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
