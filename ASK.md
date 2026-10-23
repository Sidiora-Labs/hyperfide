kind: permission

May task 0.7 install the Linux shared libraries required to execute the existing Electron native-module verification test?

Options:
- Recommended: approve installing Electron runtime libraries with apt-get.
- Reject installation and provide a runtime-equipped sandbox.

Blocked: the full test gate cannot launch Electron because libglib-2.0.so.0 and other GTK, NSS, X11, audio and accessibility shared libraries are missing.

Finished anyway: the identity sweep and gate, frozen install, workspace typecheck/build, and repairs for rename-dependent test failures. The full app, server, host-daemon and fake-provider integration suites pass; all seven repaired packages pass their retests. No test is skipped or weakened.
