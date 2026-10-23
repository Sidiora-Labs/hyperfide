# Vision

## Goal

Describe the long-term direction for hyperfide platform and the principles that should guide major
product and architecture decisions.

## What hyperfide platform Is

hyperfide platform is a programmable workspace for coding agents. It should be a system that
users, teams, and agents can shape around their own tools, infrastructure, and
workflows.

## Principles

- **Users and agents are both first-class operators**: hyperfide platform is meant to be used
  directly by users and programmatically by agents. The web app, CLI, managers,
  and future surfaces should expose the same core functionality. The CLI should
  not be treated as a sidecar or an afterthought.
- **Extensible**: hyperfide platform should support custom providers, environments,
  LLM-backed services, CLI integrations, UI surfaces, and future extension
  points. The system should adapt to a user's infrastructure and workflows, not
  force them to fork hyperfide platform.
- **Flexible, not rigid**: hyperfide platform should provide strong defaults and built-in flows
  without forcing users into one blessed way of working. Managed and unmanaged
  flows should both feel natural, and hyperfide platform should be built from reusable
  primitives instead of hard-coded special cases.
- **Works wherever you are**: hyperfide platform should work well on one machine today without
  closing off remote orchestration, cloud execution, peer-backed environments,
  or mobile access later.
- **Fast and understandable**: hyperfide platform should stay responsive, lightweight, and
  understandable. Performance, operational simplicity, and low cognitive
  overhead are part of the product.
- **Easy to trust and adopt**: hyperfide platform should remain easy to evaluate and adopt in a
  local mode, especially for teams with security and trust constraints. Hosted
  features can extend hyperfide platform later, but they should not replace the core product.
