package codes.madera.crossfog.watchlink

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

class CopyResult(val size: Long, val head: ByteArray)

/** Streams between app-private files and documents the user picked; nothing backup-sized is held in memory. */
class SaveAs(private val resolver: ContentResolver, cacheDir: File) {
  private val cacheRoot = cacheDir.canonicalFile

  /** Copies a cache file into the document at `uri` and returns the bytes written; a failed copy deletes the document. */
  fun copyToUri(sourcePath: String, uri: Uri): Long {
    val source = inCache(sourcePath)
    val out = resolver.openOutputStream(uri, "w") ?: throw IOException("cannot open the document")
    try {
      return out.use { sink -> source.inputStream().use { input -> copy(input, sink).size } }
    } catch (e: Exception) {
      // The picker has already created the document; a half-written one must not stay.
      deleteQuietly(uri)
      throw e
    }
  }

  /** Copies the document at `uri` into a cache file and returns its size and first bytes; a failed copy deletes the file. */
  fun copyFromUri(uri: Uri, destPath: String): CopyResult {
    val dest = inCache(destPath)
    val input = resolver.openInputStream(uri) ?: throw IOException("cannot open the document")
    try {
      return input.use { source -> dest.outputStream().use { sink -> copy(source, sink) } }
    } catch (e: Exception) {
      dest.delete()
      throw e
    }
  }

  /** The provider's display name for the document, or null when it gives none; a file: URI returns its last path segment. */
  fun displayName(uri: Uri): String? {
    if (uri.scheme == "file") return uri.lastPathSegment
    return resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }
  }

  // JS hands over paths, so one outside the cache directory is refused rather than trusted.
  private fun inCache(path: String): File {
    val file = File(Uri.parse(path).path ?: path).canonicalFile
    require(file.path.startsWith(cacheRoot.path + File.separator)) { "path is outside the cache directory" }
    return file
  }

  private fun deleteQuietly(uri: Uri) {
    try {
      if (uri.scheme == "file") File(uri.path ?: return).delete()
      else DocumentsContract.deleteDocument(resolver, uri)
    } catch (_: Exception) {
    }
  }

  internal companion object {
    private const val BUFFER_BYTES = 1024 * 1024
    private const val HEAD_BYTES = 16

    fun copy(input: InputStream, output: OutputStream): CopyResult {
      val buffer = ByteArray(BUFFER_BYTES)
      val head = ByteArray(HEAD_BYTES)
      var size = 0L
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        if (size < HEAD_BYTES) buffer.copyInto(head, size.toInt(), 0, minOf(n, HEAD_BYTES - size.toInt()))
        output.write(buffer, 0, n)
        size += n
      }
      return CopyResult(size, head.copyOf(minOf(size, HEAD_BYTES.toLong()).toInt()))
    }
  }
}
