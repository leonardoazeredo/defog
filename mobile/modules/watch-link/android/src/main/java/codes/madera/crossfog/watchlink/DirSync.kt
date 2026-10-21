package codes.madera.crossfog.watchlink

import android.system.Os
import android.system.OsConstants
import java.io.File

/** Flushes a directory's entries; `File` offers no way to, and a rename is not durable until this runs. */
internal fun fsyncDirectory(dir: File) {
  val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
  try {
    Os.fsync(fd)
  } finally {
    Os.close(fd)
  }
}
