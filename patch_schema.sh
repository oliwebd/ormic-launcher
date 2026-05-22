#!/bin/bash
sed -i '/<key name="show-search-bar" type="b">/i \    <key name="show-groups-sidebar" type="b">\n      <default>true</default>\n      <summary>Show groups sidebar</summary>\n    </key>\n' /home/waleee/oliwebd/oramic-Launcher/schemas/org.gnome.shell.extensions.ormic-launcher.gschema.xml
glib-compile-schemas /home/waleee/oliwebd/oramic-Launcher/schemas/
