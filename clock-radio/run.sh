#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Clock Radio"
cd /opt/clock-radio || exit 1
exec node src/index.js
