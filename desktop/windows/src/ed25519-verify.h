// Ed25519 signature check (TweetNaCl's public-domain arithmetic; see ed25519-verify.cpp).
#pragma once
#include <cstddef>

namespace saraupdate {
/** SHA-512 through Windows (BCrypt). */
bool sha512(const unsigned char* data, size_t len, unsigned char out[64]);
/** True when sig (R || s, 64 bytes) is a valid Ed25519 signature of msg by the 32-byte public key pk. */
bool ed25519Verify(const unsigned char sig[64], const unsigned char* msg, size_t len, const unsigned char pk[32]);
}  // namespace saraupdate
