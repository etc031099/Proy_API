FROM nodered/node-red:latest

USER root

# --- Extra nodes used by the demo (Dashboard UI) ---
COPY package.json /data/package.json
RUN cd /data && npm install --unsafe-perm --no-update-notifier --no-fund --only=production

# --- Preload settings + flows so they survive restarts ---
# Render free instances have an ephemeral filesystem, so the flows must be
# baked into the image instead of relying on runtime persistence.
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json

# Make sure the runtime user can write (save flows) inside /data
RUN chown -R node-red:node-red /data

USER node-red

ENV FLOWS=flows.json
