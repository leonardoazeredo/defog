package codes.madera.crossfog.watchlink

import java.io.IOException

/**
 * The code and message JS gets for a failed call. The message is ours, never the exception's when
 * that may carry a file path or an id: Expo hands it to JS, which may log it.
 */
internal class Failure(val code: String, val message: String)

internal const val KEY_LOST = "ERR_KEY_LOST"
internal const val KEY_UNAVAILABLE = "ERR_KEY_UNAVAILABLE"
internal const val INVALID_STATE = "ERR_INVALID_STATE"
internal const val INVALID_ARGUMENT = "ERR_INVALID_ARGUMENT"
internal const val STORAGE = "ERR_STORAGE"
internal const val UNREADABLE = "ERR_UNREADABLE"
internal const val INVALID_FRAME = "ERR_INVALID_FRAME"
internal const val INVALID_ID = "ERR_INVALID_ID"
internal const val NOT_FOUND = "ERR_NOT_FOUND"

/**
 * A failed database-key call. Only a lost key and a refusal say anything about the key's state, and
 * a malformed key, handed in, is the caller's mistake; every other failure (a busy Keystore, a full
 * disk, a bug) is ERR_KEY_UNAVAILABLE, which JS must never read as a lost key, since replacing a key
 * that still works makes the database unreadable.
 */
internal fun keyCallFailure(e: Exception): Failure =
  when (e) {
    // Both messages are fixed text from Keys.
    is KeyLostException -> Failure(KEY_LOST, e.message ?: "the database key is lost")
    is KeyRefusedException -> Failure(INVALID_STATE, e.message ?: "the call on the key was refused")
    is IllegalArgumentException -> Failure(INVALID_ARGUMENT, "malformed database key")
    else -> Failure(KEY_UNAVAILABLE, "cannot reach the database key")
  }

/**
 * A failed staging or outbox call, or null for anything else, which the caller rethrows as itself so
 * a bug keeps its class. UnreadableItemException is an IOException, so it is matched first.
 */
internal fun stagingCallFailure(e: Exception): Failure? =
  when (e) {
    is UnreadableItemException -> Failure(UNREADABLE, "the staged item cannot be read")
    is IOException -> Failure(STORAGE, "the staging store failed")
    // Fixed text from Frames naming a field, never a value.
    is FrameException -> Failure(INVALID_FRAME, e.message ?: "invalid frame")
    is IllegalArgumentException -> Failure(INVALID_ID, "invalid id")
    else -> null
  }
