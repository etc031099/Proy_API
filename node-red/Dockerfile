FROM nodered/node-red:4.1.15-22

USER root

# --- Extra nodes used by the demo (Dashboard UI) ---
COPY package.json package-lock.json /data/
RUN cd /data && npm ci --unsafe-perm --no-update-notifier --no-fund --omit=dev

# --- Preload settings + flows so they survive restarts ---
# Render free instances have an ephemeral filesystem, so the flows must be
# baked into the image instead of relying on runtime persistence.
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json
COPY lib /data/lib

# Make sure the runtime user can write (save flows) inside /data
RUN chown -R node-red:node-red /data

USER node-red

ENV FLOWS=flows.json
