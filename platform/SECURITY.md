# Hyperfide security

Report security concerns through https://github.com/Sidiora-Labs/hyperfide/issues.
Describe affected versions, the impact, and a minimal reproduction. Never include
credentials, tokens, private repositories, or personal runtime data in an issue.

Run only providers and plugins you trust: they can execute commands and access
files within the permissions granted to their host. Review workspace setup scripts
before running them. Keep the server reachable only by intended operators and
protect any remote access with your own authenticated network controls.

Store runtime data in `~/.hyperfide`. Use the secrets plugin for credentials and
secret references in workflow records. Rotate a credential immediately if exposed.
