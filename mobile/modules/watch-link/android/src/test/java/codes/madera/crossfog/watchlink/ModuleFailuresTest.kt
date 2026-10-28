package codes.madera.crossfog.watchlink

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.KeyStoreException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ModuleFailuresTest {
  private val id = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001"

  @Test
  fun aLostKeyIsKeyLost() {
    assertEquals("ERR_KEY_LOST", keyCallFailure(KeyLostException("gone")).code)
  }

  @Test
  fun onlyARefusalIsInvalidState() {
    assertEquals("ERR_INVALID_STATE", keyCallFailure(KeyRefusedException("works")).code)
    assertEquals("ERR_KEY_UNAVAILABLE", keyCallFailure(IllegalStateException("dropped")).code)
  }

  @Test
  fun aMalformedKeyIsInvalidArgument() {
    assertEquals("ERR_INVALID_ARGUMENT", keyCallFailure(IllegalArgumentException("bad")).code)
  }

  @Test
  fun anyOtherKeyFailureIsUnavailableSoTheCallerMayRetry() {
    for (e in listOf(KeyStoreException("busy"), IOException("disk"), ClassCastException("x"))) {
      assertEquals(e.toString(), "ERR_KEY_UNAVAILABLE", keyCallFailure(e).code)
    }
  }

  @Test
  fun aKeyFailureNamesNoPath() {
    val failure = keyCallFailure(FileNotFoundException("/data/user/0/app/no_backup/keys/db.key.v1"))
    assertFalse(failure.message.contains("/"))
  }

  @Test
  fun aStorageFailureNamesNoPath() {
    val e = FileNotFoundException(File("/data/user/0/app/no_backup/staging", "$id.tmp").path)
    val failure = stagingCallFailure(e)!!
    assertEquals("ERR_STORAGE", failure.code)
    assertFalse(failure.message.contains(id))
    assertFalse(failure.message.contains("/"))
  }

  @Test
  fun anUnreadableItemIsUnreadable() {
    assertEquals("ERR_UNREADABLE", stagingCallFailure(UnreadableItemException())?.code)
  }

  @Test
  fun aBadFrameOrIdKeepsItsCode() {
    assertEquals("ERR_INVALID_FRAME", stagingCallFailure(FrameException("field x"))?.code)
    assertEquals("ERR_INVALID_ID", stagingCallFailure(IllegalArgumentException("id"))?.code)
  }

  @Test
  fun anythingElseFromTheStoreIsRethrownAsItself() {
    val bug = IllegalStateException("bug")
    assertEquals(null, stagingCallFailure(bug))
  }
}
