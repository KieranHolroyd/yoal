---
title: Docs for AI agents
description: Give coding agents the Yoal docs. Search and read them offline with yoal docs, or over MCP, and point your repository's AGENTS.md at them.
---

An AI coding agent working on a project that deploys to Yoal does better when it reads the docs than when it guesses. The `yoal docs` command searches and prints this documentation from the terminal, as Markdown the agent can read directly. The docs are bundled into the CLI, so it needs no network connection, no `yoal login` and no MCP setup. When the CLI is logged in to a control plane that runs a different version, it reads that control plane's docs instead, so what an agent reads matches what is running. This page covers the commands, the output an agent should expect, and an instruction to add to your repository so agents use it.

## Choose a route

| Route | Best for | Docs version |
| --- | --- | --- |
| `yoal docs` | Coding agents with a shell (Claude Code, Codex, Cursor and similar), scripts, offline work | The platform you are logged in to; otherwise the docs bundled with the installed CLI |
| [MCP](/clients/mcp#documentation) `search_docs` and `read_docs` | Agents already connected to your control plane over MCP | The docs of the platform version you are connected to |
| **Docs** in the dashboard | People | The running platform version |

All three use the same pages, slugs and section anchors, so a reference found one way opens the other ways too.

### Which version `yoal docs` reads

The CLI's docs come from the platform version it was built from. When you are logged in (`yoal login`, or `YOAL_URL` and `YOAL_TOKEN`), `yoal docs` asks the control plane which version it runs. If that differs from the bundled docs, it downloads that control plane's docs once, caches them in the CLI's config directory and uses them. Not logged in, offline, or with `--bundled`, it uses the bundled docs. If the control plane is newer and its docs cannot be fetched, it prints a warning to standard error first. Control planes older than this feature do not serve their docs, so the CLI uses its own. Updating the CLI along with the platform (`npm install -g @yoal/cli`) avoids the download.

The same docs are available over REST to any signed-in caller: `GET /api/v1/docs` (version and contents, or `?q=` to search), `GET /api/v1/docs/<slug>?anchor=<anchor>` (a page or section) and `GET /api/v1/docs/bundle` (every page, as the CLI uses them).

## The commands

```sh
yoal docs                          # table of contents: every page's slug and description
yoal docs search <words…>          # ranked sections with a ref and an excerpt
yoal docs read <ref>               # a page, or one section, as Markdown
yoal docs read <slug> --outline    # a page's sections and their refs, without the text
yoal docs context <question…>      # the full text of the best-matching sections, in one go
```

`yoal docs <words…>` is a shorthand: it reads the page when the words are a page ref, and searches otherwise. `yoal doc` is an alias. Subcommand aliases: `list` (`ls`, `toc`), `search` (`find`), `read` (`show`, `cat`) and `context` (`ctx`).

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-n`, `--limit <n>` | `search`, `context` | Results to return. `search` defaults to 8 (at most 50), `context` to 5 sections. |
| `-s`, `--section <id>` | `list`, `search`, `context` | Only one docs section, by id or title, for example `data`, `cli` or `"Self-hosting"`. |
| `--max-chars <n>` | `context` | Stop after about this many characters (default 20,000). The last section is cut with a pointer to the rest. |
| `--outline` | `read` | List the page's sections instead of printing its text. |
| `--json` | all | Structured output. See [JSON output](#json-output). |
| `--bundled` | all | Use the docs bundled with the CLI, never the control plane's. |

### Refs

A ref names a page, or a section of one: the page slug, then optionally `#` and the section anchor.

```sh
yoal docs read data/databases
yoal docs read data/databases#connections-and-tls
yoal docs read data/databases connections-and-tls
```

Search results print refs. Links inside the docs are refs too: a link to `/compute/scaling#autoscaling` reads with `yoal docs read compute/scaling#autoscaling`. A dashboard docs URL such as `https://control.example.com/docs/compute/scaling#autoscaling` works as well. A `##` section includes its `###` subsections.

## Search, then read

`search` prints the best-matching sections, each with its page, heading, docs section, ref and an excerpt with the matched words in bold:

```sh
yoal docs search custom domain
```

```text
1. Domains and environments › Custom domains  [Deploying]
   ref: deploying/domains-and-environments#custom-domains
   A **custom** **domain** is your own hostname, such as www.example.com, attached to one project. It serves the project's production deployment…
```

Read the best hit with `yoal docs read <ref>`. On a long page, run `yoal docs read <slug> --outline` first: it lists every section's ref and the page's length, so the agent can read only what it needs.

Search works on whole sections. Headings weigh most, then the page title, then the body. Word forms match ("deploying" finds "deploy", "databases" finds "database"), and a word also matches longer words that start with it, so `install` finds `installer`. Filler words in a question ("how do I…") are ignored. A section that contains more of your words ranks higher. Specific nouns and command names work best: `db restore point in time` rather than `my data is gone`.

## Context for one question

`context` runs the search and prints the full Markdown of the best sections, best first, within a character budget. It is the quickest way to give an agent what it needs to answer a question:

```sh
yoal docs context "how do I restore a database to a point in time" --max-chars 8000
```

Each section starts with an HTML comment carrying its ref, such as `<!-- ref: data/backups-and-pitr#restore-to-a-point-in-time -->`, so an answer can cite where it came from. A section is never printed twice: when a `##` section is included, its `###` subsections come with it unless they were already printed.

## JSON output

With `--json`, every subcommand prints one JSON object that includes `version`, the CLI's version, and `docs`: `{ source, platformVersion, platform }`, where `source` is `bundled` or `platform` and `platformVersion` is the platform version the docs describe. The fields match the MCP tools, plus a `ref` on each result.

| Command | Shape |
| --- | --- |
| `list` | `{ version, sections: [{ id, title, pages: [{ slug, title, description }] }] }` |
| `search` | `{ version, query, results: [{ slug, anchor, ref, page, section, heading, snippet, score }], hint }` |
| `read` | `{ version, slug, anchor, ref, title, description, section, markdown, sections: [{ anchor, heading, depth }], prev, next }` |
| `read --outline` | The same as `read`, without `markdown` |
| `context` | `{ version, query, sections: [{ …a search result, markdown }], truncated }` |

`anchor` is empty for a page's introduction. `snippet` marks matched words with `**`.

## Exit codes

`yoal docs` exits `0` when it printed what was asked for. A search with no matches also exits `0`: it prints a hint, and `results` is empty in JSON. An unknown page, section anchor or `--section` exits `1`, with suggestions on stderr (or in the JSON `error` object), for example the closest page slugs.

## Tell your agent about it

Agents read instruction files such as `AGENTS.md` or `CLAUDE.md` at the root of a repository. Add a short section so they look things up before guessing:

```markdown
## Yoal

This project deploys to Yoal. Before answering a question about Yoal or running an
unfamiliar `yoal` command, read the docs from the terminal:

- `yoal docs context "<question>"` prints the relevant docs sections in one go.
- `yoal docs search <words>` finds sections; `yoal docs read <ref>` prints one.
- `yoal <command> --help` shows a command's flags.

Cite the ref (for example `data/databases#connections-and-tls`) when you rely on a page.
```

`yoal docs --help` repeats these steps, so an agent that only knows the command name can find its way. Agents connected over [MCP](/clients/mcp) can use `search_docs` and `read_docs` the same way.
