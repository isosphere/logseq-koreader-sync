# Logseq Koreader Sync
A [KOReader](https://koreader.rocks/) to [Logseq](https://logseq.com/) syncing plugin

⚠️ Known to work with KOReader 2024.03.1. KOReader metadata formats change and we are unable to detect this. 
Built with a separate sidecar directory (see https://github.com/koreader/koreader/pull/10074) in mind.


This is a tool to import your annotations from KOReader in a read-only format - this is a one directional synchronization[^1]. It is not affiliated with the KOReader project.

The `_logseq-koreader-sync` page generated by this plugin is intended to be read-only. However, the blocks created within it are intended to be freely referenced elsewhere in your graph. Their UUIDs **should** not change. If they do, please create an issue.

[^1]: perhaps one day we can do bidirectional synchronization, but that sounds like a very difficult task right now. 

## 🚀 Features
- [x] Import annotations from a [KOReader](https://koreader.rocks/) metadata folder containing "*.sdr" folders with `metadata.*.lua` files.
- [x] Blocks imported by the sync persist despite future syncs - references should remain stable

## 🛠️ Usage

1. Install the plugin from the Logseq marketplace, in-app
2. Pin the "koreader-sync" icon to your Logseq toolbar
3. Press the "koreader-sync" icon on your toolbar, and when prompted locate your KOReader metadata directory
4. Reference the created blocks, but don't alter them.

I use [Syncthing](https://syncthing.net/) on Android to ensure that I have a local copy of my metadata.

![demo animation](demo.gif)
