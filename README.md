# Synapse group-chat agent

A privacy-preserving AI participant for end-to-end encrypted [Matrix](https://matrix.org) group chats.
It runs on your own machine, decrypts messages locally, and answers with a local model through
[Ollama](https://ollama.com) or any OpenAI-compatible server. No chat text goes to a third-party AI service.

## What it does

- **Answers when asked.** Mention `@synapse:test.local` or the name "Synapse", start a message with `!ai` or `!synapse`,
  or reply to one of its messages.
- **Joins in when useful.** When people go back and forth with open questions or disagreement, it can offer a
  summary that names each side. It stays silent if the model decides there is nothing to add.
- **Knows who said what.** It tells speakers apart, gives room admins' positions precedence, answers
  inside threads, and @-mentions people in its replies.
- **Fails quietly.** If the model is slow or down, it retries with backoff, then stops trying for a while,
  instead of posting errors into the chat.

## Requirements

- macOS or Linux with [Docker](https://www.docker.com/) running
- Node.js 24+
- [Ollama](https://ollama.com) with a model pulled (default `gemma3:4b`: `ollama pull gemma3:4b`)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  if friends will join from other machines (`brew install cloudflared`)

## Hosting a group chat on your machine

```bash
npm install
npm run groupchat:up                   # chat server (Synapse), Element web app, proxy
npm run groupchat:add-user -- alex     # prints a username and password; repeat per person
npm run groupchat                      # bot + public link; keep this running
```

`npm run groupchat` prints a `https://….trycloudflare.com` link. Send it to your friends with
their usernames and passwords. In Element, create a room, invite everyone plus `@synapse:test.local`,
and say `!ai hello`.

Stop with Ctrl+C, then `npm run groupchat:down`. Accounts and history are kept.

To use another model: `SYNAPSE_MODEL=llama3.1:8b npm run groupchat`. To use another
OpenAI-compatible server, also set `SYNAPSE_INFERENCE_BASE_URL` and `INFERENCE_API_KEY`.

## Tuning when it jumps in

While `npm run groupchat` runs, open **http://localhost:9470** on the same computer. Choose a
personality and save. Changes apply to the next message, with no restart:

| | Quiet | Normal (default) | Chatty |
| --- | --- | --- | --- |
| Jumps in uninvited | never | when 2+ people disagree | easily, even for one person |
| Cooldown after speaking | 45s | 45s | 15s |
| Share of heated messages needed | — | 3 of 4 | 2 of 4 |

You can also fine-tune:
- **Memory window:** how many messages it reads (4 or more)
- **Minimum people**
- **Disagreement sensitivity**
- **Cooldown**
- **Patience:** how long it waits after the last message
- **Conflict and agreement words:** extra words in any language, added to the built-in list
- **Nicknames:** names like `ai` that call the bot when they start a message

Settings are saved to `.local/settings.yaml`. The page is reachable only from this computer, not
through the public link. The same keys can go under `orchestration.turn_gating` in
`local/agent.config.yaml`. Dashboard values take precedence over the file, and the file over the preset.

## Notes

- **Secrets stay local.** They're generated on first run into `.local/`, which git ignores.
- **Sign-up is closed.** Only accounts created with `groupchat:add-user` can sign in, and the
  account-creation API isn't exposed through the public link.
- **The link changes on every start.** It's a Cloudflare quick tunnel, and it goes offline when the
  machine sleeps.
- **The bot's keys live only in memory.** After a restart it can't read messages sent before
  the restart.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | The agent: Matrix + E2EE ingestion, turn gating, context building, inference client, message formatting |
| `scripts/groupchat.ts` | Sets up, creates accounts, and runs the tunnel and bot |
| `local/` | Docker Compose stack, proxy config, homeserver and agent config templates |
