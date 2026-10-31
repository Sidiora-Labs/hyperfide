#include "install_cmd.h"
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int regular_readable(const char *filename) {
    struct stat st;
    return stat(filename, &st) == 0 && S_ISREG(st.st_mode) &&
           access(filename, R_OK) == 0;
}

static int parent(char *directory) {
    char *slash = strrchr(directory, '/');
    if (!slash || !strcmp(directory, "/")) return 0;
    if (slash == directory) directory[1] = 0;
    else *slash = 0;
    return 1;
}

static int candidate(char output[PATH_MAX], const char *directory,
                     const char *suffix) {
    int n = snprintf(output, PATH_MAX, "%s/%s", directory, suffix);
    return n > 0 && n < PATH_MAX && regular_readable(output);
}

static int checkout_entry(char output[PATH_MAX], const char *start) {
    char directory[PATH_MAX], manifest[PATH_MAX];
    if (strlen(start) >= sizeof directory) return 0;
    strcpy(directory, start);
    do {
        if (candidate(manifest, directory, "core/control-plane/package.json") &&
            candidate(output, directory,
                      "core/control-plane/dist/preparation/fleet_install.js"))
            return 1;
    } while (parent(directory));
    return 0;
}

static int self_path(char output[PATH_MAX], const char *binary) {
    ssize_t n = readlink("/proc/self/exe", output, PATH_MAX - 1);
    if (n > 0 && n < PATH_MAX - 1) { output[n] = 0; return 1; }
    if (strchr(binary, '/')) return realpath(binary, output) != NULL;
    const char *paths = getenv("PATH");
    char *copy = paths ? strdup(paths) : NULL;
    if (!copy) return 0;
    char *cursor = copy, *segment;
    int found = 0;
    while ((segment = strsep(&cursor, ":")) != NULL) {
        char filename[PATH_MAX];
        int written = snprintf(filename, sizeof filename, "%s/%s",
                               *segment ? segment : ".", binary);
        if (written > 0 && (size_t)written < sizeof filename &&
            access(filename, X_OK) == 0 && realpath(filename, output)) {
            found = 1;
            break;
        }
    }
    free(copy);
    return found;
}

int cmd_install(int argc, char **argv, const char *binary) {
    if (argc < 2) {
        fprintf(stderr, "usage: hyperfide install --job-context PATH | --package PATH --source-config PATH --envelope PATH [--status] [--json]\n");
        return 64;
    }
    char location[PATH_MAX], entry[PATH_MAX], node[PATH_MAX], cwd[PATH_MAX];
    const char *runtime = "node";
    int found = 0;
    if (self_path(location, binary) && parent(location)) {
        if (candidate(entry, location, "../services/dist/preparation/fleet_install.js")) {
            if (!candidate(node, location, "../runtime/node") || access(node, X_OK)) {
                fprintf(stderr, "hyperfide install: packaged Node runtime is unavailable\n");
                return 69;
            }
            runtime = node;
            found = 1;
        } else found = checkout_entry(entry, location);
    }
    if (!found && getcwd(cwd, sizeof cwd)) found = checkout_entry(entry, cwd);
    if (!found) {
        fprintf(stderr, "hyperfide install: prebuilt installer is unavailable; expected services/dist/preparation/fleet_install.js in the installed release or core/control-plane/dist/preparation/fleet_install.js in a source checkout\n");
        return 69;
    }
    char **command = calloc((size_t)argc + 2, sizeof *command);
    if (!command) {
        fprintf(stderr, "hyperfide install: cannot allocate command arguments\n");
        return 71;
    }
    command[0] = (char *)runtime;
    command[1] = entry;
    for (int i = 1; i < argc; i++) command[i + 1] = argv[i];
    execvp(runtime, command);
    fprintf(stderr, "hyperfide install: cannot execute installer: %s\n", strerror(errno));
    free(command);
    return 69;
}
