package codes.madera.crossfog.watchlink

import java.io.File
import java.io.IOException
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class StagingStoreTest {
  @get:Rule val tmp = TemporaryFolder()

  private val key = SecretKeySpec(ByteArray(32) { 7 }, "AES")
  private val a = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0001"
  private val b = "0b6b7a6e-4a53-4d6e-9a53-1f3f1d3a0002"
  private val dir get() = File(tmp.root, "staging")

  private fun store(
    key: SecretKeySpec = this.key,
    syncDir: (File) -> Unit = {},
    beforeRename: (String) -> Unit = {},
  ) = StagingStore(dir, key, syncDir, beforeRename)

  private class Crash : RuntimeException("injected crash")

  @Test
  fun stageThenReadReturnsTheBytes() {
    val s = store()
    s.stage(a, "hello".toByteArray())
    assertArrayEquals("hello".toByteArray(), s.read(a))
  }

  @Test
  fun listShowsTheStagedIds() {
    val s = store()
    assertEquals(emptyList<String>(), s.list())
    s.stage(b, byteArrayOf(1))
    s.stage(a, byteArrayOf(2))
    assertEquals(listOf(a, b), s.list())
  }

  @Test
  fun aCrashBeforeTheRenameLeavesNoItem() {
    val s = store(beforeRename = { throw Crash() })
    assertThrows(Crash::class.java) { s.stage(a, byteArrayOf(1)) }
    assertFalse(File(dir, "$a.bin").exists())
    assertEquals(emptyList<String>(), s.list())
    assertNull(s.read(a))
  }

  @Test
  fun aCrashBeforeTheRenameKeepsTheEarlierItem() {
    store().stage(a, "old".toByteArray())
    assertThrows(Crash::class.java) {
      store(beforeRename = { throw Crash() }).stage(a, "new".toByteArray())
    }
    assertArrayEquals("old".toByteArray(), store().read(a))
  }

  @Test
  fun stagingAgainAfterACrashSucceedsOverTheStaleFile() {
    assertThrows(Crash::class.java) {
      store(beforeRename = { throw Crash() }).stage(a, byteArrayOf(1))
    }
    val s = store()
    s.stage(a, byteArrayOf(2))
    assertArrayEquals(byteArrayOf(2), s.read(a))
    assertEquals(listOf(a), s.list())
  }

  @Test
  fun stagingTheSameIdTwiceKeepsOneItemWithTheLastBytes() {
    val s = store()
    s.stage(a, "first".toByteArray())
    s.stage(a, "second".toByteArray())
    assertEquals(listOf(a), s.list())
    assertArrayEquals("second".toByteArray(), s.read(a))
  }

  @Test
  fun theDirectoryIsSyncedAfterTheRenameAndBeforeStageReturns() {
    val seen = mutableListOf<Boolean>()
    val s = store(syncDir = { if (it.name == "staging") seen += File(it, "$a.bin").exists() })
    s.stage(a, byteArrayOf(1))
    assertEquals(listOf(true), seen)
  }

  @Test
  fun aNewDirectoryIsSyncedIntoItsParentBeforeTheFirstItemExists() {
    val synced = mutableListOf<String>()
    store(syncDir = { synced += it.name }).stage(a, byteArrayOf(1))
    store(syncDir = { synced += it.name }).stage(b, byteArrayOf(1))
    assertEquals(listOf(tmp.root.name, "staging", "staging"), synced)
  }

  @Test
  fun aFailedDirectorySyncMakesStageFailSoTheWatchIsNotConfirmed() {
    val s = store(syncDir = { throw IOException("sync failed") })
    assertThrows(IOException::class.java) { s.stage(a, byteArrayOf(1)) }
  }

  @Test
  fun releaseRemovesTheItem() {
    val s = store()
    s.stage(a, byteArrayOf(1))
    s.release(a)
    assertEquals(emptyList<String>(), s.list())
    assertNull(s.read(a))
  }

  @Test
  fun releaseAlsoRemovesAStaleTemporaryFile() {
    assertThrows(Crash::class.java) {
      store(beforeRename = { throw Crash() }).stage(a, byteArrayOf(1))
    }
    store().release(a)
    assertEquals(0, dir.listFiles()!!.size)
  }

  @Test
  fun releaseOfAnUnknownIdIsHarmless() {
    val s = store()
    s.release(a)
    s.stage(b, byteArrayOf(1))
    s.release(a)
    assertEquals(listOf(b), s.list())
  }

  @Test
  fun aTamperedByteMakesTheItemUnreadable() {
    val s = store()
    s.stage(a, "secret".toByteArray())
    val file = File(dir, "$a.bin")
    val bytes = file.readBytes()
    for (i in bytes.indices) {
      file.writeBytes(bytes.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() })
      assertThrows("byte $i", UnreadableItemException::class.java) { s.read(a) }
    }
  }

  @Test
  fun aFileMovedToAnotherIdFailsToAuthenticate() {
    val s = store()
    s.stage(a, "secret".toByteArray())
    File(dir, "$a.bin").renameTo(File(dir, "$b.bin"))
    assertThrows(UnreadableItemException::class.java) { s.read(b) }
  }

  @Test
  fun anotherKeyCannotReadTheItem() {
    store().stage(a, "secret".toByteArray())
    val other = store(key = SecretKeySpec(ByteArray(32) { 8 }, "AES"))
    assertThrows(UnreadableItemException::class.java) { other.read(a) }
  }

  @Test
  fun theFileHoldsNoPlaintext() {
    store().stage(a, "recognisable-plaintext".toByteArray())
    val raw = File(dir, "$a.bin").readBytes()
    assertFalse(String(raw, Charsets.ISO_8859_1).contains("recognisable"))
  }

  @Test
  fun readOfAnItemThatWasNeverStagedReturnsNull() {
    assertNull(store().read(a))
  }

  @Test
  fun anItemLargerThanTheFrameLimitIsUnreadableNotMissing() {
    store().stage(a, byteArrayOf(1))
    File(dir, "$a.bin").writeBytes(ByteArray(MAX_FRAME_BYTES + 1024))
    assertThrows(UnreadableItemException::class.java) { store().read(a) }
  }

  @Test
  fun idsThatAreNotUuidsAreRefusedEverywhere() {
    val s = store()
    for (bad in listOf("00000000-0000-0000-0000-000000000000", "../keys/db.key.v1", "a", "", "$a/x", "$a.bin", " $a")) {
      assertThrows(bad, IllegalArgumentException::class.java) { s.stage(bad, byteArrayOf(1)) }
      assertThrows(bad, IllegalArgumentException::class.java) { s.read(bad) }
      assertThrows(bad, IllegalArgumentException::class.java) { s.release(bad) }
    }
  }

  @Test
  fun listIgnoresFilesThatAreNotItems() {
    val s = store()
    s.stage(a, byteArrayOf(1))
    File(dir, "notes.bin").writeBytes(byteArrayOf(1))
    File(dir, "$b.tmp").writeBytes(byteArrayOf(1))
    assertEquals(listOf(a), s.list())
  }

  @Test
  fun theItemIsAnIvThenCiphertextAndTag() {
    store().stage(a, ByteArray(10))
    assertEquals(12 + 10 + 16, File(dir, "$a.bin").length().toInt())
  }

  @Test
  fun stageCreatesTheDirectory() {
    assertFalse(dir.exists())
    store().stage(a, byteArrayOf(1))
    assertTrue(dir.isDirectory)
  }
}
