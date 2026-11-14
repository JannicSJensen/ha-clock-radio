# Clock Radio - Home Assistant app

[![CI](https://github.com/JannicSJensen/ha-clock-radio/actions/workflows/ci.yaml/badge.svg)](https://github.com/JannicSJensen/ha-clock-radio/actions/workflows/ci.yaml)
[![Add repository to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FJannicSJensen%2Fha-clock-radio)

A calm bedside clock and radio dashboard, built on the same concept as
[Dasher](https://github.com/JannicSJensen/ha-dasher-addon): a standalone Home
Assistant app (add-on), a small Node.js server, and a vanilla JavaScript tablet
page with no build step, HACS cards, or tablet-side Home Assistant token.

## Initial foundation

- Large clock, date, configurable time zone, 12/24-hour display and seconds.
- Responsive dark dashboard and an optional warmer night palette.
- Home Assistant speaker discovery, speaker selection, radio presets, play,
  pause, stop and volume (where the selected player supports them).
- Stream URLs and Home Assistant media-source presets; optional Music Assistant
  library radio playback through its Home Assistant integration.
- Ingress sidebar access and a separate tablet page on port **8100** (Dasher
  remains on 8099, so both apps can run together).
- Supervisor-provided credentials, server-side command restrictions, read-only
  mode and explicit connection/configuration errors.
- Persistent `dashboard.yaml`, seeded on first start and reloaded within five
  seconds. Invalid edits show an error and retain the last valid configuration.
- A fictional local demo, automated tests, app linting and image-build CI.

This is a focused starter, not a copy of Dasher's full feature set. An optional
[Home Assistant alarm package](examples/home-assistant/README.md) adds two
independent Music/Buzzer profiles with wake times, weekday switches and
auto-stop timers, configured through native HA entities cards. The tablet does
not yet include an alarm editor. Sleep timers and Music Assistant library
browsing are not implemented. Playback happens on your HA speaker, not the tablet.

## Install

Requires Home Assistant OS or a Supervisor installation on amd64 or aarch64.

1. Open **Settings > Apps > App store > Repositories** (called **Add-ons** on
   older versions).
2. Add `https://github.com/JannicSJensen/ha-clock-radio`.
3. Install **Clock Radio**, start it and choose **Open web UI**.
4. Configure your radio presets in the app's `dashboard.yaml`; see
   [settings and examples](clock-radio/DOCS.md).
5. On a tablet, open `http://<home-assistant>:8100/`.

The image is built locally by Supervisor; an external container registry is
not required. For ingress-only access, disable the 8100 host-port mapping in
the app's Network settings.

**Trust boundary:** the direct tablet page has no login, like Dasher. Anyone
able to reach port 8100 can see the configured player information and control
allowed players. Keep it on a trusted LAN; do not expose it to the internet.
Use ingress for authenticated access. Empty `players` allows all discovered
media players; explicitly list players to narrow control.

## Development

```sh
cd clock-radio/app
npm ci
npm run dev
# Open http://localhost:8100/ (fake HA, no real audio or HA access).
```

The demo creates ignored configuration under `clock-radio/app/dev/config/`.
It starts its mock HA on a free loopback port and stops it when the app exits.
`PORT=8101 npm run dev` selects another dashboard port.

For real Home Assistant development:

```sh
export HA_URL=http://homeassistant.local:8123
read -rs -p 'HA token: ' HA_TOKEN; echo
export HA_TOKEN
CONFIG_DIR="$HOME/.config/ha-clock-radio" npm start
```

Keep tokens out of files and source control. This real configuration folder is
outside the repository and separate from the demo. Do not reuse the demo
station URLs for real playback; they are fictional.

```sh
npm run check
npm test
docker build --build-arg BUILD_VERSION=0.2.0 --build-arg BUILD_ARCH=amd64 ../
```

## Layout and releases

```text
repository.yaml                  Home Assistant app-store repository
clock-radio/
  config.yaml, Dockerfile        Supervisor definition and image
  run.sh, translations/          startup and app options
  README.md, DOCS.md, CHANGELOG.md
  app/
    src/                         configuration, HA API, policy and HTTP server
    web/                         standalone clock/radio dashboard
    examples/dashboard.yaml      first-run configuration
    dev/, test/                  fake HA and automated tests
.github/workflows/ci.yaml         tests, app linter and Docker build
```

For user-visible changes, run `npm version <version> --no-git-tag-version` in
`clock-radio/app/`, update `clock-radio/config.yaml`, and add a matching release
heading to `clock-radio/CHANGELOG.md`. Commit the feature and version together.
Tests enforce agreement between app, package, lockfile and changelog versions.
Push to `main`, then refresh the HA app store to see updates. User configuration
is never overwritten on upgrade; see the example file for new settings.

## Foundation and license

Based on the packaging and dashboard concept of
[JannicSJensen/ha-dasher-addon](https://github.com/JannicSJensen/ha-dasher-addon)
(MIT). This focused implementation uses REST polling every five seconds rather
than Dasher's broader WebSocket/registry integration. No Dasher assets, unrelated
pages or private configuration are bundled.

[MIT license](LICENSE).
