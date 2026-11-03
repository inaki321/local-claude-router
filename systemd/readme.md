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
