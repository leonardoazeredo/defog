package codes.madera.crossfog.watchlink

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// createDocument needs a person at the picker, so only the two copies run here, on file:// targets.
@RunWith(AndroidJUnit4::class)
class SaveAsTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext
  private val dir = File(context.cacheDir, "saveas-test")
  private val saveAs by lazy { SaveAs(context.contentResolver, context.cacheDir) }

  @Before
  fun start() {
    dir.deleteRecursively()
    dir.mkdirs()
  }

  @After
  fun finish() {
    dir.deleteRecursively()
  }

  private fun data(n: Int) = ByteArray(n) { (it * 13 + 1).toByte() }

  @Test
  fun aCopyOutAndBackIsByteForByte() {
    val original = File(dir, "original.bin").apply { writeBytes(data(3_000_000)) }
    val target = File(dir, "target.bin")
    assertEquals(original.length(), saveAs.copyToUri(original.path, Uri.fromFile(target)))

    val back = File(dir, "back.bin")
    val r = saveAs.copyFromUri(Uri.fromFile(target), back.path)
    assertEquals(original.length(), r.size)
    assertArrayEquals(original.readBytes(), back.readBytes())
    assertArrayEquals(original.readBytes().copyOf(16), r.head)
  }

  @Test
  fun aFileDocumentIsNamedByItsFile() {
    assertEquals("named.db", saveAs.displayName(Uri.fromFile(File(dir, "named.db"))))
  }

  @Test
  fun aFileUriSourceIsAccepted() {
    val original = File(dir, "a.bin").apply { writeBytes(data(10)) }
    val target = File(dir, "t.bin")
    saveAs.copyToUri(Uri.fromFile(original).toString(), Uri.fromFile(target))
    assertArrayEquals(original.readBytes(), target.readBytes())
  }

  @Test
  fun aSourceOutsideTheCacheIsRefused() {
    val outside = File(context.filesDir, "secret.bin").apply { writeBytes(data(4)) }
    try {
      assertThrows(IllegalArgumentException::class.java) {
        saveAs.copyToUri(outside.path, Uri.fromFile(File(dir, "t.bin")))
      }
    } finally {
      outside.delete()
    }
  }

  @Test
  fun aDestinationOutsideTheCacheIsRefused() {
    val source = File(dir, "s.bin").apply { writeBytes(data(4)) }
    assertThrows(IllegalArgumentException::class.java) {
      saveAs.copyFromUri(Uri.fromFile(source), File(context.filesDir, "x.bin").path)
    }
  }

  @Test
  fun aTraversalOutOfTheCacheIsRefused() {
    val sneaky = File(dir, "../../files/x.bin").path
    assertThrows(IllegalArgumentException::class.java) {
      saveAs.copyFromUri(Uri.fromFile(File(dir, "s.bin")), sneaky)
    }
  }

  @Test
  fun aFailedCopyInLeavesNoPartialFile() {
    val dest = File(dir, "dest.bin")
    assertThrows(Exception::class.java) {
      saveAs.copyFromUri(Uri.fromFile(File(dir, "missing.bin")), dest.path)
    }
    assertFalse(dest.exists())
  }
}
