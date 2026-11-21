// Runs argv[1..] as its own TCC-responsible process (exec in place), so macOS asks for and records the microphone
// grant for that program, not for whatever started it (launchd, or a hardened parent that cannot be prompted for).
// Uses responsibility_spawnattrs_setdisclaim, an undocumented but long-standing macOS API.
// Built by scripts/bridge-install.ts:  cc -O2 -o disclaim native/disclaim.c
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: disclaim cmd [args]\n"); return 2; }
  posix_spawnattr_t a; posix_spawnattr_init(&a);
  posix_spawnattr_setflags(&a, POSIX_SPAWN_SETEXEC);
  responsibility_spawnattrs_setdisclaim(&a, 1);
  int e = posix_spawn(NULL, argv[1], NULL, &a, argv + 1, environ);
  perror("posix_spawn"); return e ? 127 : 0;
}
