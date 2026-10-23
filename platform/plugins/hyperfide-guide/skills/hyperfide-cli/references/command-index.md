# Core command index

This index lists every command path that the core CLI registers, including aliases: `thread get|view|status` run `thread show`, `thread message|send` run `thread tell`, `thread messages|timeline` run `thread log`, `thread create|new` run `thread spawn`, `terminal read` runs `terminal output`, `plugin uninstall` runs `plugin remove`, and `environment get` runs `environment show`. At the top level `hyperfide-platform host`, `hyperfide-platform hosts`, and `hyperfide-platform machines` run `hyperfide-platform machine`, `hyperfide-platform env` runs `hyperfide-platform environment`, and the plurals `threads`, `projects`, `terminals`, `providers`, `plugins`, and `skills` run their singular command, unless a plugin registers that name. `hyperfide-platform guide commands <group>` prints a group's commands with every option on one page. Check live help for flags and defaults.

## status

- `hyperfide-platform status`

## settings

- `hyperfide-platform settings`
- `hyperfide-platform settings show`
- `hyperfide-platform settings mobile-app`
- `hyperfide-platform settings ai-services`
- `hyperfide-platform settings ai-services show`
- `hyperfide-platform settings ai-services set`
- `hyperfide-platform settings ai-services test`
- `hyperfide-platform settings cli-command`
- `hyperfide-platform settings cli-command show`
- `hyperfide-platform settings cli-command install`
- `hyperfide-platform settings cli-command remove`
- `hyperfide-platform settings general`
- `hyperfide-platform settings replay-onboarding`
- `hyperfide-platform settings completed-turns`
- `hyperfide-platform settings experiment`
- `hyperfide-platform settings keyboard`
- `hyperfide-platform settings keyboard hints`
- `hyperfide-platform settings keyboard list`
- `hyperfide-platform settings keyboard set`
- `hyperfide-platform settings keyboard reset`
- `hyperfide-platform settings ui`
- `hyperfide-platform settings ui list`
- `hyperfide-platform settings ui get`
- `hyperfide-platform settings ui set`
- `hyperfide-platform settings ui reset`
- `hyperfide-platform settings usage`
- `hyperfide-platform settings version`
- `hyperfide-platform settings reload`

`hyperfide-platform settings usage` accepts `--refresh` to fetch fresh provider usage.

## project

- `hyperfide-platform project`
- `hyperfide-platform project source`
- `hyperfide-platform project source add`
- `hyperfide-platform project source update`
- `hyperfide-platform project source delete`
- `hyperfide-platform project attachment`
- `hyperfide-platform project attachment upload`
- `hyperfide-platform project attachment download`
- `hyperfide-platform project list`
- `hyperfide-platform project discover`
- `hyperfide-platform project history`
- `hyperfide-platform project reorder`
- `hyperfide-platform project branches`
- `hyperfide-platform project paths`
- `hyperfide-platform project commands`
- `hyperfide-platform project files`
- `hyperfide-platform project content`
- `hyperfide-platform project create`
- `hyperfide-platform project show`
- `hyperfide-platform project update`
- `hyperfide-platform project delete`

## prompt-history

- `hyperfide-platform prompt-history`
- `hyperfide-platform prompt-history list`

## provider

- `hyperfide-platform provider`
- `hyperfide-platform provider list`
- `hyperfide-platform provider enable`
- `hyperfide-platform provider disable`
- `hyperfide-platform provider models`

## machine

- `hyperfide-platform machine`
- `hyperfide-platform machine providers`
- `hyperfide-platform machine enroll`
- `hyperfide-platform machine env`
- `hyperfide-platform machine env list`
- `hyperfide-platform machine env set`
- `hyperfide-platform machine env unset`
- `hyperfide-platform machine create`
- `hyperfide-platform machine list`
- `hyperfide-platform machine show`
- `hyperfide-platform machine reconnect`
- `hyperfide-platform machine rename`
- `hyperfide-platform machine remove`
- `hyperfide-platform machine suspend`
- `hyperfide-platform machine resume`
- `hyperfide-platform machine reconcile`
- `hyperfide-platform machine retry-cleanup`
- `hyperfide-platform machine retry-update`
- `hyperfide-platform machine provider-cli`
- `hyperfide-platform machine provider-cli status`
- `hyperfide-platform machine provider-cli install`

## server

- `hyperfide-platform server`
- `hyperfide-platform server move`
- `hyperfide-platform server move status`
- `hyperfide-platform server move cancel`
- `hyperfide-platform server export`
- `hyperfide-platform server import`
- `hyperfide-platform server unlock`
- `hyperfide-platform server allow-connect`
- `hyperfide-platform server delete-old-copy`
- `hyperfide-platform server install-machine-service`

## updates

- `hyperfide-platform updates`
- `hyperfide-platform updates status`
- `hyperfide-platform updates apply`
- `hyperfide-platform updates app`
- `hyperfide-platform updates app status`
- `hyperfide-platform updates app apply`
- `hyperfide-platform updates app dismiss`

## terminal

- `hyperfide-platform terminal`
- `hyperfide-platform terminal list`
- `hyperfide-platform terminal create`
- `hyperfide-platform terminal start`
- `hyperfide-platform terminal show`
- `hyperfide-platform terminal attach`
- `hyperfide-platform terminal send`
- `hyperfide-platform terminal resize`
- `hyperfide-platform terminal output`
- `hyperfide-platform terminal read`
- `hyperfide-platform terminal wait`
- `hyperfide-platform terminal rename`
- `hyperfide-platform terminal restart`
- `hyperfide-platform terminal close`
- `hyperfide-platform terminal stop`

## thread

- `hyperfide-platform thread`
- `hyperfide-platform thread wait`
- `hyperfide-platform thread spawn`
- `hyperfide-platform thread create`
- `hyperfide-platform thread new`
- `hyperfide-platform thread fork`
- `hyperfide-platform thread list`
- `hyperfide-platform thread show`
- `hyperfide-platform thread get`
- `hyperfide-platform thread view`
- `hyperfide-platform thread status`
- `hyperfide-platform thread log`
- `hyperfide-platform thread messages`
- `hyperfide-platform thread timeline`
- `hyperfide-platform thread output`
- `hyperfide-platform thread open`
- `hyperfide-platform thread pane`
- `hyperfide-platform thread section`
- `hyperfide-platform thread section list`
- `hyperfide-platform thread section create`
- `hyperfide-platform thread section rename`
- `hyperfide-platform thread section delete`
- `hyperfide-platform thread search`
- `hyperfide-platform thread history`
- `hyperfide-platform thread read`
- `hyperfide-platform thread unread`
- `hyperfide-platform thread reorder-pinned`
- `hyperfide-platform thread count`
- `hyperfide-platform thread queue`
- `hyperfide-platform thread queue list`
- `hyperfide-platform thread queue create`
- `hyperfide-platform thread queue update`
- `hyperfide-platform thread queue send`
- `hyperfide-platform thread queue delete`
- `hyperfide-platform thread queue reorder`
- `hyperfide-platform thread queue group`
- `hyperfide-platform thread tabs`
- `hyperfide-platform thread tabs show`
- `hyperfide-platform thread tabs set`
- `hyperfide-platform thread update`
- `hyperfide-platform thread archive`
- `hyperfide-platform thread unarchive`
- `hyperfide-platform thread restore-environment`
- `hyperfide-platform thread pin`
- `hyperfide-platform thread unpin`
- `hyperfide-platform thread delete`
- `hyperfide-platform thread edit-message`
- `hyperfide-platform thread tell`
- `hyperfide-platform thread message`
- `hyperfide-platform thread send`
- `hyperfide-platform thread retry`
- `hyperfide-platform thread stop`
- `hyperfide-platform thread compact`
- `hyperfide-platform thread context`
- `hyperfide-platform thread commands`
- `hyperfide-platform thread options`
- `hyperfide-platform thread clear`
- `hyperfide-platform thread cancel-plan`
- `hyperfide-platform thread clear-goal`
- `hyperfide-platform thread interactions`
- `hyperfide-platform thread interactions list`
- `hyperfide-platform thread interactions show`
- `hyperfide-platform thread interactions approve`
- `hyperfide-platform thread interactions grant`
- `hyperfide-platform thread interactions answer`
- `hyperfide-platform thread interactions respond`
- `hyperfide-platform thread interactions deny`

## environment

- `hyperfide-platform environment`
- `hyperfide-platform environment providers`
- `hyperfide-platform environment list`
- `hyperfide-platform environment delete`
- `hyperfide-platform environment cleanup`
- `hyperfide-platform environment show`
- `hyperfide-platform environment get`
- `hyperfide-platform environment status`
- `hyperfide-platform environment branches`
- `hyperfide-platform environment paths`
- `hyperfide-platform environment diff`
- `hyperfide-platform environment diff-files`
- `hyperfide-platform environment diff-file`
- `hyperfide-platform environment diff-patch`
- `hyperfide-platform environment diff-viewed`
- `hyperfide-platform environment diff-viewed list`

  Repeat `--path` for a bounded lookup.

- `hyperfide-platform environment diff-viewed mark`
- `hyperfide-platform environment diff-viewed unmark`
- `hyperfide-platform environment diff-viewed clear`
- `hyperfide-platform environment update`
- `hyperfide-platform environment commit`
- `hyperfide-platform environment archive-threads`

## file

- `hyperfide-platform file`
- `hyperfide-platform file read`
- `hyperfide-platform file write`
- `hyperfide-platform file list`
- `hyperfide-platform file paths`
- `hyperfide-platform file mkdir`
- `hyperfide-platform file move`
- `hyperfide-platform file remove`

## theme

- `hyperfide-platform theme`
- `hyperfide-platform theme list`
- `hyperfide-platform theme set`
- `hyperfide-platform theme dir`
- `hyperfide-platform theme favicon`
- `hyperfide-platform theme favicon set`
- `hyperfide-platform theme favicon reset`
- `hyperfide-platform theme show`
- `hyperfide-platform theme reset`

## plugin

- `hyperfide-platform plugin`
- `hyperfide-platform plugin search`
- `hyperfide-platform plugin list`
- `hyperfide-platform plugin source`
- `hyperfide-platform plugin install`
- `hyperfide-platform plugin install-jobs`
- `hyperfide-platform plugin cancel-install`
- `hyperfide-platform plugin outdated`
- `hyperfide-platform plugin update`
- `hyperfide-platform plugin update-jobs`
- `hyperfide-platform plugin new`
- `hyperfide-platform plugin types`
- `hyperfide-platform plugin migrate`
- `hyperfide-platform plugin build`
- `hyperfide-platform plugin dev`
- `hyperfide-platform plugin reload`
- `hyperfide-platform plugin rpc`
- `hyperfide-platform plugin rpc list`
- `hyperfide-platform plugin rpc inspect`
- `hyperfide-platform plugin rpc call`
- `hyperfide-platform plugin enable`
- `hyperfide-platform plugin disable`
- `hyperfide-platform plugin safe-mode`
- `hyperfide-platform plugin prune`
- `hyperfide-platform plugin config`
- `hyperfide-platform plugin token`
- `hyperfide-platform plugin run`
- `hyperfide-platform plugin logs`
- `hyperfide-platform plugin remove`
- `hyperfide-platform plugin uninstall`

## marketplace

- `hyperfide-platform marketplace`
- `hyperfide-platform marketplace add`
- `hyperfide-platform marketplace list`
- `hyperfide-platform marketplace refresh`
- `hyperfide-platform marketplace remove`

## skill

- `hyperfide-platform skill`
- `hyperfide-platform skill list`
- `hyperfide-platform skill show`
- `hyperfide-platform skill files`
- `hyperfide-platform skill update`
- `hyperfide-platform skill delete`
- `hyperfide-platform skill search`
- `hyperfide-platform skill registry`
- `hyperfide-platform skill registry detail`
- `hyperfide-platform skill install`
- `hyperfide-platform skill cli-skills-status`
- `hyperfide-platform skill install-cli-skills`

## guide

- `hyperfide-platform guide`

## diagnostics

- `hyperfide-platform diagnostics`
- `hyperfide-platform diagnostics cli-errors`

## voice

- `hyperfide-platform voice`
- `hyperfide-platform voice transcribe`

## browser

- `hyperfide-platform browser`
- `hyperfide-platform browser instances`
- `hyperfide-platform browser tabs`
- `hyperfide-platform browser create`
- `hyperfide-platform browser acquire`
- `hyperfide-platform browser connection`
- `hyperfide-platform browser release`
- `hyperfide-platform browser reveal`
- `hyperfide-platform browser close`
- `hyperfide-platform browser capture`
- `hyperfide-platform browser watch`
- `hyperfide-platform browser import-sources`
- `hyperfide-platform browser import-cookies`
