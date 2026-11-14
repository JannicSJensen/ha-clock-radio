# Home Assistant alarm helpers

The optional [package](clock_radio_alarms.yaml) runs alarms in Home Assistant,
independently of an open tablet or the Clock Radio app process. It requires the
Music Assistant integration and a Music Assistant speaker with volume and repeat
support. This is native HA configuration, not an alarm editor in the tablet UI.

## Install

1. Enable packages in your HA configuration if they are not already enabled:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

2. Copy `clock_radio_alarms.yaml` into that `packages` directory. Do not overwrite
   another package or duplicate an existing `homeassistant:` section.
3. Check configuration. Reload input booleans, numbers, selects, text, timers,
   templates, scripts and automations; restart HA if a required integration has
   not previously been loaded.
4. Run `script.clock_radio_initialize` once. It is guarded by
   `input_boolean.clock_radio_initialized`, so normal reloads/restarts do not
   reset your choices.
5. Set these helpers:
   - `input_text.clock_radio_player`: your Music Assistant `media_player` ID.
   - `input_text.clock_radio_music_source`: a radio URI from your MA library,
     e.g. `library://radio/123`, or an HTTP(S) radio stream.
   - `input_text.clock_radio_buzzer_source`: a reachable HTTP(S) audio URL.
     For an existing HA file under `www/sounds/`, use an absolute URL such as
     `http://homeassistant:8123/local/sounds/wakeup.mp3` if that hostname is
     reachable from your Music Assistant server. A bare `/local/...` path is
     not a Music Assistant media URI. No sound file is bundled.
6. Add [alarm-cards.yaml](alarm-cards.yaml) as a manual card in a native HA
   dashboard. It uses standard entities cards, without HACS dependencies.
7. Test a profile from Developer tools > Actions using
   `script.clock_radio_play_alarm` with `alarm: "1"` or `"2"`. This manual
   action intentionally works even when the schedule is disabled.

## Defaults and controls

| Profile | Type | Wake time | Weekdays | Duration | Volume | Enabled |
| --- | --- | --- | --- | --- | --- | --- |
| Alarm 1 | Music | 06:00 | Monday-Friday | 5 minutes | 50% | No |
| Alarm 2 | Buzzer | 06:15 | Monday-Friday | 5 minutes | 50% | No |

Each profile has its own enable switch, type selector, hour/minute sliders, wake
time display, seven weekday switches, volume, duration and countdown timer.
Either profile can be Music or Buzzer. Playback sources and the speaker are
shared settings. Values restore across restarts rather than being reset by YAML
`initial` fields.

Scheduling uses **Home Assistant's time zone**, checked at the start of each
minute. It does not replay alarms missed while HA was stopped. Both profiles can
be enabled independently; when their playback overlaps, the later start replaces
the earlier alarm because they share one speaker. Changing a schedule does not
immediately trigger it in the middle of a minute.

Music replaces the speaker's MA queue with the configured radio station. Buzzer
repeats the configured sound until its own countdown expires. A playback startup
failure is logged and produces a persistent notification. Stop any running alarm
with `script.clock_radio_stop`; disabling its schedule only prevents future
starts. Automatic/manual stop restores the speaker's previous volume and repeat
setting, but does **not** restore an interrupted queue or resume previous music.

Countdowns restore on HA restart, and startup cleanup stops any alarm that was
active before the restart. For critical wake-ups, keep an independent backup:
HA, Music Assistant, the network and speaker must all be available.
