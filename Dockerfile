# Static hosting for the editor. Nothing server-side: the app reads and writes
# your inventory on your own machine through the File System Access API, so this
# image only ever serves files.
#
# Unprivileged nginx, so it runs as a non-root user on port 8080 and needs no
# securityContext gymnastics on k3s.
# todo version https://hub.docker.com/r/nginxinc/nginx-unprivileged/tags
FROM nginxinc/nginx-unprivileged:1.31.4-alpine

# IMPORTANT: inventory.yaml is deliberately not copied in. It is your data, it
# does not belong in an image, and the app never needs a server-side copy.
COPY --chown=nginx:nginx index.html /usr/share/nginx/html/index.html
COPY --chown=nginx:nginx settings.yaml /usr/share/nginx/html/settings.yaml
COPY --chown=nginx:nginx css/ /usr/share/nginx/html/css/
COPY --chown=nginx:nginx js/ /usr/share/nginx/html/js/
COPY --chown=nginx:nginx third_party/ /usr/share/nginx/html/third_party/
COPY --chown=nginx:nginx schema/ /usr/share/nginx/html/schema/
COPY --chown=nginx:nginx deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
