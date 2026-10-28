package codes.madera.crossfog.watchlink

import android.content.Context
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
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
  private val sqliteDir = File(context.cacheDir, "keys-test-sqlite")

  private fun keys() = Keys(context, sqliteDir)

  private fun aliasPresent() =
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(Keys.KEK_ALIAS)

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
  fun aFileWithoutTheKeystoreKeyIsALostKey() {
    val keys = Keys(context)
    keys.databaseKey()
    KeyStore.getInstance("AndroidKeyStore").apply {
      load(null)
      deleteEntry(Keys.KEK_ALIAS)
    }
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
  fun aFileThatDoesNotMatchTheKeystoreKeyIsUnreadable() {
    val keys = Keys(context)
    keys.databaseKey()
    keys.databaseKeyFile.writeBytes(ByteArray(60))
    assertEquals(KeyState.UNREADABLE, Keys(context).keyState())
  }

  @Test
  fun anAliasWithOnlyAStrayNewFileIsALostKey() {
    val keys = keys()
    keys.databaseKey()
    val stray = File(keys.databaseKeyFile.path + ".new")
    assertTrue(keys.databaseKeyFile.renameTo(stray))
    assertEquals(KeyState.LOST, keys.keyState())
    assertThrows(KeyLostException::class.java) { keys.databaseKey() }
  }

  @Test
  fun resetWithNoDatabaseRecoversAKillBetweenTheKeystoreKeyAndTheFile() {
    val keys = keys()
    keys.databaseKey()
    val stray = File(keys.databaseKeyFile.path + ".new")
    assertTrue(keys.databaseKeyFile.renameTo(stray))
    keys.resetKeys()
    assertFalse(stray.exists())
    assertFalse(aliasPresent())
    assertEquals(KeyState.FRESH, keys.keyState())
    assertEquals(32, keys.databaseKey().size)
    assertEquals(KeyState.EXISTING, keys.keyState())
  }

  @Test
  fun resetWithNoDatabaseDropsAFileWithoutItsKeystoreKey() {
    val keys = keys()
    keys.databaseKey()
    KeyStore.getInstance("AndroidKeyStore").apply {
      load(null)
      deleteEntry(Keys.KEK_ALIAS)
    }
    keys.resetKeys()
    assertFalse(keys.databaseKeyFile.exists())
    assertEquals(KeyState.FRESH, keys.keyState())
  }

  @Test
  fun resetWithNoDatabaseDropsAnUnreadableKey() {
    val keys = keys()
    keys.databaseKey()
    keys.databaseKeyFile.writeBytes(ByteArray(60))
    keys.resetKeys()
    assertEquals(KeyState.FRESH, keys.keyState())
    assertEquals(32, keys.databaseKey().size)
  }

  @Test
  fun resetIsRefusedWhileADatabaseFileExists() {
    for (name in listOf("crossfog.db", "crossfog.replaced.db")) {
      reset()
      val keys = keys()
      keys.databaseKey()
      keys.databaseKeyFile.delete()
      File(sqliteDir, name).writeBytes(ByteArray(16))
      assertThrows(name, IllegalStateException::class.java) { keys.resetKeys() }
      assertEquals(name, KeyState.LOST, keys.keyState())
      assertTrue(name, aliasPresent())
    }
  }

  @Test
  fun resetIsRefusedForAKeyThatStillWorks() {
    val keys = keys()
    val key = keys.databaseKey()
    assertThrows(IllegalStateException::class.java) { keys.resetKeys() }
    assertArrayEquals(key, keys.databaseKey())
  }

  @Test
  fun replacingAnUnreadableKeyKeepsTheGivenKey() {
    val keys = Keys(context)
    keys.databaseKey()
    keys.databaseKeyFile.writeBytes(ByteArray(60))
    assertEquals(KeyState.UNREADABLE, keys.keyState())
    val fresh = ByteArray(32) { (it + 1).toByte() }
    keys.replaceLostDatabaseKey(fresh.copyOf())
    assertEquals(KeyState.EXISTING, keys.keyState())
    assertArrayEquals(fresh, Keys(context).databaseKey())
  }

  @Test
  fun anEmptyOrTruncatedFileIsALostKey() {
    val keys = Keys(context)
    keys.databaseKey()
    for (size in listOf(0, 10)) {
      keys.databaseKeyFile.writeBytes(ByteArray(size))
      assertThrows("size $size", KeyLostException::class.java) { Keys(context).databaseKey() }
    }
  }

  @Test
  fun twoInstancesRacingOnAFreshInstallAgreeOnTheKey() {
    val results = java.util.concurrent.ConcurrentLinkedQueue<ByteArray>()
    val threads = List(4) { Thread { results.add(Keys(context).databaseKey()) } }
    threads.forEach { it.start() }
    threads.forEach { it.join() }
    assertEquals(4, results.size)
    results.forEach { assertArrayEquals(results.first(), it) }
  }

  @Test
  fun theStagingKeyIsTheSameAcrossInstances() {
    val first = Keys(context).stagingKey()
    val second = Keys(context).stagingKey()
    assertEquals(KeyProperties.KEY_ALGORITHM_AES, first.algorithm)
    // Keystore keys expose no material, so equal handles to one alias are the check.
    assertEquals(first, second)
  }

  @Test
  fun replacingALostKeyKeepsTheGivenKey() {
    val keys = Keys(context)
    val old = keys.databaseKey()
    keys.databaseKeyFile.delete()
    assertEquals(KeyState.LOST, keys.keyState())
    val fresh = ByteArray(32) { (it + 1).toByte() }
    keys.replaceLostDatabaseKey(fresh.copyOf())
    assertFalse(fresh.contentEquals(old))
    assertEquals(KeyState.EXISTING, keys.keyState())
    assertArrayEquals(fresh, Keys(context).databaseKey())
  }

  @Test
  fun aKeyThatStillWorksCannotBeReplaced() {
    val keys = Keys(context)
    val key = keys.databaseKey()
    assertThrows(IllegalStateException::class.java) { keys.replaceLostDatabaseKey(ByteArray(32)) }
    assertArrayEquals(key, keys.databaseKey())
  }

  @Test
  fun aLostKeyIsNotReplacedWithAKeyOfTheWrongLength() {
    val keys = Keys(context)
    keys.databaseKey()
    keys.databaseKeyFile.delete()
    assertThrows(IllegalArgumentException::class.java) { keys.replaceLostDatabaseKey(ByteArray(16)) }
    assertEquals(KeyState.LOST, keys.keyState())
  }

  private fun reset() {
    Keys(context).databaseKeyFile.delete()
    File(Keys(context).databaseKeyFile.path + ".new").delete()
    sqliteDir.deleteRecursively()
    sqliteDir.mkdirs()
    KeyStore.getInstance("AndroidKeyStore").apply {
      load(null)
      listOf(Keys.KEK_ALIAS, Keys.STAGING_ALIAS).forEach { if (containsAlias(it)) deleteEntry(it) }
    }
  }
}
