// #3940: observe successful real macOS fsync calls in an owned XCTest child.
// Compile: xcrun clang -dynamiclib -Wall -Wextra -Werror SOURCE -o AUDIT.dylib
// Run the selected SwiftPM test binary with DYLD_INSERT_LIBRARIES=AUDIT.dylib.
// No failure injection or replacement filesystem: the original fsync always
// executes, and its return value/errno pass through unchanged. Not power-loss QA.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static int audit_fsync(int descriptor) {
  int result = fsync(descriptor);
  int saved_errno = errno;
  struct stat status;
  char path[1024];
  if (fstat(descriptor, &status) == 0 &&
      (S_ISDIR(status.st_mode) || S_ISREG(status.st_mode)) &&
      fcntl(descriptor, F_GETPATH, path) == 0) {
    char line[1200];
    const char *kind = S_ISDIR(status.st_mode) ? "DIRECTORY" : "FILE";
    int length = snprintf(line, sizeof(line), "MAPLE_%s_SYNC %d %s\n", kind, result, path);
    if (length > 0 && (size_t)length < sizeof(line)) {
      (void)write(STDERR_FILENO, line, (size_t)length);
    }
  }
  errno = saved_errno;
  return result;
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} interpose_fsync __attribute__((section("__DATA,__interpose"))) = {
    (const void *)audit_fsync, (const void *)fsync};
