#include "platform_cmd.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int executable(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode) && access(path, X_OK) == 0;
}

int cmd_platform(char **argv) {
    char root[PATH_MAX], probe[PATH_MAX], local[PATH_MAX];
    if (!getcwd(root, sizeof root)) {
        fprintf(stderr, "hyperfide platform: cannot resolve current directory: %s\n", strerror(errno));
        return 69;
    }
    strcpy(probe, root);
    /* A git worktree needs no graph initialization to use the platform. */
    for (;;) {
        char marker[PATH_MAX];
        struct stat st;
        int n = snprintf(marker, sizeof marker, "%s/.git", probe);
        int found = n > 0 && (size_t)n < sizeof marker && stat(marker, &st) == 0;
        n = snprintf(marker, sizeof marker, "%s/.codegraph", probe);
        found |= n > 0 && (size_t)n < sizeof marker && stat(marker, &st) == 0;
        if (found) { strcpy(root, probe); break; }
        if (!strcmp(probe, "/")) break;
        char *slash = strrchr(probe, '/');
        if (slash == probe) probe[1] = 0;
        else *slash = 0;
    }
    if (setenv("HYPERFIDE_REPO_ROOT", root, 1) != 0) {
        fprintf(stderr, "hyperfide platform: cannot set HYPERFIDE_REPO_ROOT: %s\n", strerror(errno));
        return 69;
    }
    const char *override = getenv("HYPERFIDE_PLATFORM_BIN");
    const char *selected = NULL;
    if (override && *override && executable(override)) selected = override;
    int n = snprintf(local, sizeof local, "%s/apps/cli/bin/hyperfide-platform", root);
    if (!selected && n > 0 && (size_t)n < sizeof local && executable(local)) selected = local;
    if (selected) {
        argv[0] = (char *)selected;
        execv(selected, argv);
        fprintf(stderr, "hyperfide platform: cannot execute '%s': %s\n", selected, strerror(errno));
    } else {
        argv[0] = "hyperfide-platform";
        execvp(argv[0], argv);
        fprintf(stderr, "hyperfide platform: CLI unavailable: checked HYPERFIDE_PLATFORM_BIN (%s), "
                "%s, and hyperfide-platform on PATH: %s\n",
                override && *override ? override : "unset", local, strerror(errno));
    }
    return 69;
}
