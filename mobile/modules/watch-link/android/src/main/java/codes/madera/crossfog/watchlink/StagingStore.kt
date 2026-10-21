package codes.madera.crossfog.watchlink

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import javax.crypto.AEADBadTagException
import javax.crypto.SecretKey

/**
 * Encrypted files that survive while JS is not running: one `<id>.bin` per item, AES-GCM under [key]
 * with the id as AAD (so a file renamed to another id fails to authenticate). Nothing here touches
 * Android APIs, so it runs in JVM tests; the directory sync is injected for that reason.
 *
 * One instance per directory: [Synchronized] only serializes callers of the same instance.
 */
class StagingStore(
  private val dir: File,
  private val key: SecretKey,
  private val syncDir: (File) -> Unit,
  private val beforeRename: (String) -> Unit = {},
) {
  /** Durable on return: the file and its directory entry are synced, so the watch may delete its copy. */
  @Synchronized
  fun stage(id: String, bytes: ByteArray) {
    requireId(id)
    if (!dir.isDirectory) {
      check(dir.mkdirs()) { "cannot create the staging directory" }
      // The new directory's own entry lives in its parent; without this a power loss after the
      // first stage can take the whole directory, and the watch has already deleted its copy.
      syncDir(dir.parentFile!!)
    }
    val blob = KeyWrap(key, id).wrap(bytes)
    val tmp = File(dir, "$id.tmp")
    // A failure leaves the .tmp behind, as a crash would: the next stage of this id overwrites it
    // and release removes it, and list never reports it.
    FileOutputStream(tmp).use { out ->
      out.write(blob)
      out.fd.sync()
    }
    beforeRename(id)
    if (!tmp.renameTo(File(dir, "$id.bin"))) throw IOException("cannot rename the staged file")
    syncDir(dir)
  }

  @Synchronized
  fun list(): List<String> =
    dir.listFiles().orEmpty()
      .map { it.name }
      .filter { it.endsWith(BIN) && ID.matches(it.removeSuffix(BIN)) }
      .map { it.removeSuffix(BIN) }
      .sorted()

  /** Null for an absent, oversized or unauthenticated item; an unreadable file still throws. */
  @Synchronized
  fun read(id: String): ByteArray? {
    requireId(id)
    val file = File(dir, "$id$BIN")
    if (!file.exists() || file.length() > MAX_FRAME_BYTES + OVERHEAD_BYTES) return null
    return try {
      KeyWrap(key, id).unwrap(file.readBytes())
    } catch (e: AEADBadTagException) {
      null
    }
  }

  @Synchronized
  fun release(id: String) {
    requireId(id)
    for (name in listOf("$id$BIN", "$id.tmp")) {
      val file = File(dir, name)
      // delete() cannot tell a missing file from one it failed to remove.
      if (!file.delete() && file.exists()) throw IOException("cannot delete a staged file")
    }
  }

  private fun requireId(id: String) = require(ID.matches(id)) { "invalid staging id" }

  private companion object {
    const val BIN = ".bin"
    // IV (12) and GCM tag (16), see KeyWrap.
    const val OVERHEAD_BYTES = 28
    // The id becomes a file name and arrives from watch frames and from JS. The RFC form; it matches
    // zod's uuid() except that the nil and max UUIDs are rejected here. A looser match would stage
    // items that pendingActivities then skips.
    val ID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
  }
}
