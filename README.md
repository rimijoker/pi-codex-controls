# pi-codex-controls

Two commands for Pi's built-in OpenAI Codex provider.

## Install

```sh
pi install npm:pi-codex-controls
```

Restart Pi or run `/reload` after installation.

## Commands

- `/codex-fast` adds `service_tier: "priority"` to requests using the Codex Responses API.
- `/codex-context` raises Pi's local context window to 1,050,000 tokens.
- Run either command again to turn it off.

The footer shows the active settings.
Fast mode is session-scoped.
Context preferences are saved per provider/model in `codex-controls.json` inside Pi's config directory (default `~/.pi/agent`) and restored in new sessions.
Run `/codex-context` again to restore the catalog budget and clear that model's saved preference.

## Limits

Fast mode asks the endpoint for priority service.
One live request with Fast enabled succeeded, but the response did not show whether priority was honored.

The context command changes Pi's local context and compaction budget.
It does not change a server-side limit.

One live GPT-6 Luna request with 276,431 input tokens succeeded.
That confirms one request above Pi's 272,000-token catalog value, not support for the full 1.05M budget.
Provider limits can change.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Tests

```sh
bun test
```

The tests run offline and do not send model requests.
