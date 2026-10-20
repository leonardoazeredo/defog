package codes.madera.crossfog.watchlink

import android.content.Context
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.security.KeyStore
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KeysTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext

  @Before
  fun start() = reset()

  @After
  fun finish() = reset()

  @Test
  fun firstCallCreatesTheFileAndReturnsThirtyTwoBytes() {
    val keys = Keys(context)
    assertEquals(KeyState.FRESH, keys.keyState())
    val key = keys.databaseKey()
    assertEquals(32, key.size)
    assertTrue(keys.databaseKeyFile.exists())
    assertEquals(KeyState.EXISTING, keys.keyState())
  }

  @Test
  fun theFileLivesUnderNoBackupFilesDir() {
    val keys = Keys(context)
    keys.databaseKey()
    assertTrue(keys.databaseKeyFile.path.startsWith(context.noBackupFilesDir.path))
  }

  @Test
  fun aSecondInstanceReturnsTheSameBytes() {
    val first = Keys(context).databaseKey()
    assertArrayEquals(first, Keys(context).databaseKey())
  }

  @Test
  fun theKeyOnDiskIsNotTheKey() {
    val keys = Keys(context)
    val key = keys.databaseKey()
    assertFalse(keys.databaseKeyFile.readBytes().contentEquals(key))
  }

  @Test
  fun deletingTheFileWithTheAliasPresentIsALostKey() {
    val keys = Keys(context)
    keys.databaseKey()
    assertTrue(keys.databaseKeyFile.delete())
    assertEquals(KeyState.LOST, keys.keyState())
    assertThrows(KeyLostException::class.java) { keys.databaseKey() }
  }

  @Test
  fun aDamagedFileIsALostKey() {
    val keys = Keys(context)
    keys.databaseKey()
    keys.databaseKeyFile.writeBytes(ByteArray(60))
    assertThrows(KeyLostException::class.java) { Keys(context).databaseKey() }
  }

  @Test
  fun theStagingKeyIsTheSameAcrossInstances() {
    val first = Keys(context).stagingKey()
    val second = Keys(context).stagingKey()
    assertEquals(KeyProperties.KEY_ALGORITHM_AES, first.algorithm)
    // Keystore keys expose no material, so equal handles to one alias are the check.
    assertEquals(first, second)
  }

  private fun reset() {
    Keys(context).databaseKeyFile.delete()
    KeyStore.getInstance("AndroidKeyStore").apply {
      load(null)
      listOf("crossfog.kek.v1", "crossfog.staging.v1").forEach { if (containsAlias(it)) deleteEntry(it) }
    }
  }
}
