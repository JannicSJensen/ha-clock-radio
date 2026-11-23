# Clock Radio

Four pages for Home Assistant tablets: **The Clock**, **Alarm configuration**,
**Music overview** and **Settings**. Nightstand-style clock faces and widgets,
Dasher's Music Assistant
browsing/player, and two independent HA-backed Music/Buzzer alarms.

Open it from the Home Assistant sidebar or at `http://<home-assistant>:8100/`.
The app connects to Home Assistant using Supervisor credentials; tablets never
receive those credentials. It controls your Home Assistant speakers and does
not play alarm audio in the browser. The optional **Preview sound** button
plays a short preview on the tablet/browser only.

Alarm configuration, Music and Settings return to The Clock after two minutes
of inactivity. Set `return_to_clock_minutes` in the HA app configuration to
change it (`0` disables it), then restart. Open dialogs and pending saves pause
the countdown; music and unsaved Settings drafts are preserved.

Clock settings and saved alarm definitions persist in this browser as a
read-only snapshot. An offline banner shows the last synchronization time;
controls stay disabled until HA reconnects. Requests have deadlines, and
timed-out changes are never replayed. This does not run alarms without HA or
guarantee that a cold browser reload works without the dashboard server.

For native scheduling, select **kiosk_satellite** under **Alarm backend** in the HA app
configuration and provide the kiosk's Remote Administration URL and password
for automatic token renewal, or a manually renewed API token.
The existing editor then manages Clock Radio's native alarms. Choose music
and native buzzer tones in **Clock Radio's alarm editor**. New music
selections use **Music Assistant > show-01**, without source/speaker controls;
saved music and inherited KS defaults remain unchanged until you select
another item. Native tone fallback remains available. HA remains the default, and
existing HA schedules are untouched. Native ringing/defaults stay on Kiosk.
**Switching back does not cancel native alarms.**
See [setup, limitations and cleanup](DOCS.md#kiosk-satellite-alarm-backend).

**Settings > Kiosk Satellite updates** can check and install updates on the
configured KS device with either alarm backend. Installation requires
confirmation and an idle native alarm engine, and uses KS's own updater.
See [KS updates](DOCS.md#updating-kiosk-satellite) for restart/confirmation
requirements and recovery after an uncertain request.

**Settings > Proximity screen dimming** can configure the KS device to dim
its screen to a native 10% level after 10 minutes of inactivity and restore
the saved brightness on proximity. Clock Radio stays visible and KS owns
the timer/restoration, with either alarm backend.
See [proximity dimming](DOCS.md#proximity-screen-dimming).

Buzzer alarms can each select one of twelve original built-in sounds.
Update the HA alarm package to scheduler version 7 and configure a
speaker-accessible HA internal URL; see [sound setup](DOCS.md#buzzer-alarm-sounds).

## Screenshots

The Clock with an analog face and calendar, using fictional demo data:

![The Clock with an analog face and calendar widget](https://raw.githubusercontent.com/JannicSJensen/ha-clock-radio/main/docs/screenshots/clock.png)

See the [four-page screenshot gallery](https://github.com/JannicSJensen/ha-clock-radio#screenshots)
and the illustrated guide below for alarm editing, ringing screens and night mode.

See [documentation](DOCS.md) for configuration, safety and troubleshooting,
and [release notes](CHANGELOG.md) for updates.
