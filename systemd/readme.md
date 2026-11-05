# systemd user units

Every time the machine starts systemd turns on litellm

`claude-litellm.service.template` is rendered by `../install.sh` into
`~/.config/systemd/user/claude-litellm.service`. It runs LiteLLM on
`127.0.0.1:4000` (change with `--port`) and reads keys from
`~/.config/litellm/env`.

```bash
systemctl --user status claude-litellm
journalctl --user -u claude-litellm -f
```

Rerun `install.sh` after moving the `litellm` binary so `ExecStart` points at it.

## ollama.service (optional, disabled)

The default workflow is a manual `ollama serve` with the env vars in
`../OLLAMA.md`. This unit is only for running the same server at login; it is
**not enabled** on this machine.

```bash
# only if you want systemd to manage it:
install -m 644 ollama.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ollama

# turn it back off:
systemctl --user disable --now ollama
```

Keep the system-wide `/etc/systemd/system/ollama.service` disabled. It would
bind :11434 and reads `/usr/share/ollama/.ollama/models`, which does not have
these models (they live in `~/.ollama/models`).
