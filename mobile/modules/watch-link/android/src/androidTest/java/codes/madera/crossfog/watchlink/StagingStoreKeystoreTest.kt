package codes.madera.crossfog.watchlink

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// Runs on a device so the Keystore-backed staging key and the real directory sync are exercised;
// the JVM tests use a software key and a no-op sync.
@RunWith(AndroidJUnit4::class)
class StagingStoreKeystoreTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val dir = File(context.cacheDir, "staging-keystore-test")
  private val id = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001"

  @Before
  fun start() {
    dir.deleteRecursively()
  }

  @After
  fun finish() {
    dir.deleteRecursively()
  }

  private fun store() = StagingStore(dir, Keys(context).stagingKey(), ::fsyncDirectory)

  @Test
  fun stagedBytesReadBackUnderTheKeystoreKey() {
    store().stage(id, "payload".toByteArray())
    assertArrayEquals("payload".toByteArray(), store().read(id))
    assertEquals(listOf(id), store().list())
  }

  @Test
  fun aTamperedFileDoesNotAuthenticate() {
    store().stage(id, "payload".toByteArray())
    val file = File(dir, "$id.bin")
    file.writeBytes(file.readBytes().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
    assertNull(store().read(id))
  }

  @Test
  fun releaseRemovesTheItem() {
    store().stage(id, "payload".toByteArray())
    store().release(id)
    assertEquals(emptyList<String>(), store().list())
  }
}
