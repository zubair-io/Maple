// #3940: revoke read permission on one owned test directory after the actual
// XMP inode changes. Darwin open() still executes and returns its real EACCES;
// no sidecar writer or syscall result is mocked. Tests restore permissions.
// Compile as a dylib and load only in the selected owned XCTest child.
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void revoke_after_publication(const char *directory) {
  const char *name = strrchr(directory, '/');
  if (!name || strncmp(name + 1, "removal-keep-recovery-", 22) != 0) return;
  char marker[1024], sidecar[1024];
  if (snprintf(marker, sizeof(marker), "%s/.revoke-sidecar-access", directory) >= (int)sizeof(marker) ||
      snprintf(sidecar, sizeof(sidecar), "%s/photo.xmp", directory) >= (int)sizeof(sidecar)) return;
  FILE *input = fopen(marker, "r");
  if (!input) return;
  unsigned long long previous = 0;
  int parsed = fscanf(input, "%llu", &previous);
  fclose(input);
  struct stat current;
  if (parsed != 1 || stat(sidecar, &current) != 0 ||
      (unsigned long long)current.st_ino == previous) return;
  // Write/execute remain available for normal rename cleanup; an O_RDONLY
  // directory descriptor is now genuinely denied by the filesystem.
  if (chmod(directory, 0300) == 0) {
    char line[1200];
    int count = snprintf(line, sizeof(line), "MAPLE_REAL_ACCESS_REVOCATION %llu %llu %s\n",
                         previous, (unsigned long long)current.st_ino, directory);
    if (count > 0 && (size_t)count < sizeof(line)) (void)write(STDERR_FILENO, line, (size_t)count);
  }
}

static int probe_open(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list args;
    va_start(args, flags);
    mode = (mode_t)va_arg(args, int);
    va_end(args);
  }
  int original_errno = errno;
  if ((flags & O_DIRECTORY) && (flags & O_ACCMODE) == O_RDONLY) revoke_after_publication(path);
  errno = original_errno;
  return open(path, flags, mode);
}

__attribute__((used)) static const struct {
  const void *replacement;
  const void *original;
} interpose_open __attribute__((section("__DATA,__interpose"))) = {
    (const void *)probe_open, (const void *)open};
