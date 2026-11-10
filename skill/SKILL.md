---
name: explain-deck
description: Turn an explanation into a narrated slide deck that plays itself in the browser - spoken audio per step, synced to highlighted code, mermaid diagrams, folder trees and screenshots, exported as one self-contained HTML file. Use this whenever the user runs /explain-deck, or asks to be walked through / talked through / shown how something works, wants a narrated or visual or audio explanation, a video or presentation or walkthrough of code, a plan, a diff, a PR, or a file. Prefer this over a wall of text whenever the user says they want to see or hear the explanation rather than read it. Also use it when the user asks to host, share or publish an explainer deck or presentation as an artifact (see Hosting a deck as an artifact).
---

# Explain

Turns an explanation into a single HTML file that plays itself: it narrates a
step, lights up the lines or nodes that step is about, and advances on its own
when the audio ends. Audio, syntax highlighter and diagram renderer are all
inlined, so the file works offline, over `file://`, with no server and no
network.

Speech is synthesised locally. Nothing is sent anywhere.

## The pipeline

You write `deck.json`. The build script does the rest.

1. Gather the content. Where it comes from depends on how you were invoked:
   - **no arguments** - explain your own immediately preceding reply or plan
   - **free text** - explain that text
   - **a file, diff, or PR** - read it, then walk through the real code
   - **a question about the codebase** - research it first, then explain the answer
2. Write `deck.json` into a new folder, one folder per explainer. The output is
   named after that folder, so `2026-05-04-rx-ingestion/` gives you
   `2026-05-04-rx-ingestion.html`.
3. Build it with the `explain-deck` CLI (npx fetches it; nothing to install):
   ```
   npx -y explain-deck@1 build <folder>/deck.json
   ```
   Add `--no-open` when you are testing, in a subagent, or otherwise not sitting
   in front of the user's screen. Add `--folder` to emit the multi-file form
   (`index.html` plus loose clips) instead, which is worth it only for very long
   decks where a single inlined file gets unwieldy.
4. Tell the user the path to the HTML file in one line. Don't summarise the deck
   back at them in text - the deck is the deliverable, and repeating it defeats
   the point. Worth mentioning once: space pauses, arrow keys navigate, `S`
   toggles the sidebar, `T` changes theme, `M` (or the mute button) mutes the narration, `F` enters full screen, `?` opens
   help, and every slide is clickable in the sidebar.

**First run takes longer.** npx downloads the CLI and the build downloads a
speech model into `~/.cache`. That is a one-time cost of a minute or two (on
Apple Silicon with `uv`, it also builds the fast MLX environment); after that it only ever re-renders clips whose words changed, so fixing a
sentence rebuilds in well under a second. Say so if the user is watching a first
build and wondering why it is slow.

## Build the deck.json with a script, not by hand

This is the part that goes wrong. A code slide needs the source as a JSON string
with escaped newlines, and its `lit` values are line numbers **counted inside the
snippet**, not in the original file. Transcribing that by hand across six slides
reliably produces an off-by-one that no one notices until the wrong line lights
up mid-sentence.

So write a small throwaway script that slices the real files and dumps the deck:

```python
lines = open("src/rx/ingest.py").read().split("\n")
snippet = "\n".join(lines[41:58])          # the slice you want to show
deck = {"title": "...", "slides": [
    {"kind": "code", "title": "Choosing the parser", "file": "src/rx/ingest.py",
     "lang": "python", "code": snippet,
     "steps": [{"say": "...", "lit": "1-3"}]},   # 1 = line 42 of the file
]}
json.dump(deck, open("deck.json", "w"), indent=2)
```

The build validates what it can - unknown `kind`, a missing content field, a
step with no `say`, a `lit` pointing past the end of a snippet or bullet list,
and an ambiguous mermaid `lit` - and refuses to build with a message naming the
slide. It cannot check that you lit the *right* line, which is exactly why the
slicing should be mechanical.

## deck.json

```json
{
  "title": "How Rx ingestion parses a PDF",
  "voice": "af_heart",
  "speed": 1.0,
  "slides": [
    {
      "kind": "bullets",
      "title": "Three things happen",
      "bullets": ["A parser is chosen", "Pages become blocks", "Blocks become signals"],
      "steps": [
        {"say": "Ingestion does three things, and they are easier to hold onto separately."},
        {"say": "First it decides which parser this document needs.", "lit": [0]},
        {"say": "Then every page is flattened into a list of text blocks.", "lit": [1]}
      ]
    }
  ]
}
```

`voice`, `speed` and `page_title` are optional and apply to the whole deck.
`page_title` is the page's `<title>` — the browser tab and the name a hosted
artifact shows — so make it a short name of two to four words ("RT-210 redesign
cycle"); without it the `title` is used. The default voice
is `af_heart`; there are 28 Kokoro voices, `af_*` and `bf_*` female, `am_*` and
`bm_*` male, with `a` American and `b` British.

Every slide carries a `steps` array, and every step is `{say, lit}`. That
uniformity is the whole design: the step's audio duration *is* its screen time,
so narration and highlighting can never drift apart and there is no timing
metadata to maintain.

### Slide kinds

| `kind` | Content fields | What `lit` selects |
|---|---|---|
| `bullets` | `bullets: []` | array of 0-based indices to emphasise; bullets after the highest one stay hidden |
| `code` | `code`, `lang` | line numbers within the snippet, 1-based: `"12"`, `"1-8"`, `"3,7,10-12"` |
| `tree` | `code` (the tree as plain text) | line numbers, same syntax; rendered without a line-number gutter |
| `mermaid` | `mermaid` (diagram source) | array of node ids, or fragments of node labels, to light up |
| `image` | `src` (path relative to the folder) | `[x, y, w, h]` in percent, spotlighting a region |

Any slide may also carry `title`, and `file` - a monospace second line under the
title. It is just a subtitle slot: a path on a code slide, but plain words work
fine on a concept slide ("roughly what BaseEventLoop does").

Omitting `lit` shows the slide with nothing singled out, which is the right
opening step for a diagram or a list you are about to walk through. On a
`bullets` slide that means every bullet is visible but none emphasised.

`image` is the one kind that does not survive a standalone build, because the
file is referenced rather than inlined - use `--folder` if a deck needs
screenshots, or skip the kind.

### Mermaid specifics

A `lit` string lights a node when it appears anywhere in that node's label, or
is the node's id - so short distinctive fragments like `"selector waits"` are
fine. The build rejects any value matching zero or more than one node and prints
the available labels, so an ambiguous fragment is a build error rather than a
diagram that quietly lights the wrong box. Give every node an explicit id and
quote its label, both because it makes `lit` unambiguous and because
parentheses, dots and quotes in a bare label break mermaid's parser:

```
graph TD
  A["Ready queue"] --> B["selector.select(timeout)"]
```

If a diagram fails to parse, the page shows a red error where the diagram should
be and the build says nothing - the terminal will look perfectly healthy. Open
the deck before you hand it over.

Walking a diagram one node per step turns it into an animation of the flow, and
is usually the best thing this skill can do for a question about how pieces fit
together. Such a slide will have as many steps as the diagram has nodes, which
is fine - the per-slide step guidance below is about prose slides.

## Writing narration that sounds like a person

`say` is read aloud by a speech model, so it is speech, not prose. This is where
decks are won or lost.

- No markdown, no bullet characters, no backticks. They get read literally.
- Spell out what a symbol sounds like: "arrow" not `->`, "dot py" not `.py`,
  "line twelve" not `L12`, "O C R" for an initialism you want pronounced
  letter by letter.
- One idea per step, one to three sentences - which lands around five to fifteen
  seconds of audio. If a step needs four sentences it is two steps.
- Write the way you would talk to a colleague at a whiteboard. "Notice this
  branch - it's the only place the scanned path gets taken" lands; "This
  conditional evaluates the is_scanned predicate" does not.
- Say *why*, not *what*. The code is on screen already; the reader can see what
  it does. Your job is the reason it is shaped that way, and what would break if
  it weren't.

## Choosing what goes on screen

Reach for a diagram when the answer is about how pieces relate, a flow, a
lifecycle, or a decision tree - add them on your own judgment rather than
waiting to be asked.

Use real code, copied verbatim from the repo, not code you wrote for the slide.
Keep a snippet under about forty lines so the lines stay readable - elide the
middle with a comment rather than shrinking the font. If a function is too big
for one slide, that is usually two slides, and often the honest thing to point
out about it.

Use `tree` when the shape of a directory is the point.

## Shape of a good deck

Six to ten slides, three to five steps on a prose slide, is the range that feels
right - call it twenty to forty steps, which at roughly ten seconds each lands
between three and eight minutes.

Open with a slide that says what question is being answered and why the user
should care. Close by landing the point: what they now know, or what they should
do with it.

Resist the urge to cover everything. A deck that explains three things well is
worth more than one that mentions nine.

## Hosting a deck as an artifact

When the user asks to host, share or publish a presentation ("host this in an
artifact", "put the deck online"), publish the built standalone HTML with the
`Artifact` tool. Everything is inlined, so it is one file and needs no
`files` map.

1. **Find the file.** It is the `<folder>/<folder>.html` the build printed. If
   the user names a folder or an older deck, use the `.html` in it; never
   publish `deck.json` or the `steps/` clips.
2. **Check the size.** `ls -la`: an artifact page may be at most 16 MB. A
   standalone deck is usually 5–8 MB. If it is over, rebuild with `--folder`
   and publish `index.html` with every `steps/*.mp3` (and any `img/*`) in
   `files`, mapping each published path to its source path.
3. **Check the name.** The artifact is named by the page's `<title>`
   (`grep -o '<title>[^<]*' <file>`). Decks built before `page_title` existed
   say "Explainer": add a short `page_title` to `deck.json` and rebuild — the
   audio is cached, so it takes seconds — rather than editing the HTML.
4. **Read before you publish.** The artifact rules require reading a file you
   did not just write; a deck you built this session counts as written, an
   older one does not. Read `deck.json` (the HTML is mostly inlined audio) to
   know what you are sharing.
5. **A refused publish for U+FFFD.** The artifact check refuses a page that
   contains the replacement character. Mermaid's inlined source has one, and
   the build writes it as `\uFFFD`, so a deck built before 2026-10-22 just
   needs a rebuild. If the character is in `deck.json` itself, fix the
   narration text instead.
6. **Publish.** `Artifact` with `file_path` = the HTML, `icon` = `slides` (or
   `presentation`), and a one-sentence `description` of what the deck explains.
   To update a deck already hosted, publish the same file path again (same
   session) or pass its `url` (another session) — the link stays the same.
7. **Tell the user** the link in one line, and that it is private until they
   share it from the page's Share menu. If the deck shows client material
   (customer documents, screenshots of client data), say it is for internal
   sharing only.

The player works inside the artifact frame unchanged: space pauses, arrow keys
move, `M` mutes, `S` shows the slide list, `F` goes full screen.

