# Third-party components

VidRush setup downloads third-party binaries at installation time. They are not committed to this repository.

| Component | Source | License information |
| --- | --- | --- |
| yt-dlp | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | Source is primarily Unlicense. Standalone binaries include other components; consult the release and [third-party notices](https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt). |
| FFmpeg / FFprobe | [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) | Setup selects the GPL build. Consult [FFmpeg legal information](https://ffmpeg.org/legal.html) and the build repository for corresponding source and build instructions. |
| Node.js | Existing compatible runtime, or an official Windows LTS ZIP from [nodejs.org](https://nodejs.org/dist/) | Node.js and bundled dependencies retain their licenses; downloaded runtimes include their LICENSE file. See [Node.js LICENSE](https://github.com/nodejs/node/blob/main/LICENSE). |
| Playwright | Development dependency from npm | Apache-2.0; see [Playwright LICENSE](https://github.com/microsoft/playwright/blob/main/LICENSE). Browser downloads have their own applicable licenses. |

If you redistribute an installer or a bundle containing these binaries, review the corresponding component licenses and source/notice obligations first. This repository's installer fetches dependencies directly from their upstream distribution sources.
