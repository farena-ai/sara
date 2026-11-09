# Launch kit (1.0)

Everything for making the repository public, prepared ahead so release day is mostly clicking.
Nothing here posts or publishes by itself.

| File | What it's for |
|---|---|
| [REPO_SETUP.md](REPO_SETUP.md) | GitHub settings: description, topics, social preview, Discussions, labels, roadmap board, branch rules. [`scripts/repo-setup.sh`](../../scripts/repo-setup.sh) applies the parts `gh` can do (prints only, unless `--apply`). |
| [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md) | The 60–90 second video: shot list, spoken lines, how to record on Windows, Mac and iPhone. |
| [SHOW_HN.md](SHOW_HN.md) | Facts and structure for a Show HN post (HN asks for hand-written text). |
| [REDDIT_SELFHOSTED.md](REDDIT_SELFHOSTED.md) · [REDDIT_LOCALLLAMA.md](REDDIT_LOCALLLAMA.md) · [REDDIT_HOMEASSISTANT.md](REDDIT_HOMEASSISTANT.md) | Drafts that follow each subreddit's rules (re-read them before posting). |
| [X_THREAD.md](X_THREAD.md) | An eight-post thread for X. |
| [AWESOME_LISTS.md](AWESOME_LISTS.md) | Entries and PR text for awesome lists, and which ones Sara doesn't qualify for yet. |
| [social-preview.html](social-preview.html) | The source of [`docs/social-preview.png`](../social-preview.png) (1280×640). |
| [`docs/images/brand/`](../images/brand/) | README hero and section illustrations (OpenAI GPT Image 2 art with the Sara wordmark set in Georgia/Segoe UI on top; see [PROVENANCE.md](../images/brand/PROVENANCE.md)) and the social preview to upload, [`sara-social-preview.jpg`](../images/brand/sara-social-preview.jpg) (1280×640). |

Order on release day: repository public → `repo-setup.sh --apply` → social preview → video on the
README → demo checked → posts (one community per day, starting with the one you'll have most time
to answer in) → awesome lists that already accept Sara.

Every number in these drafts comes from [RESULTS.md](../RESULTS.md); if you re-run the
benchmarks before posting, update the drafts to match, caveats included.
