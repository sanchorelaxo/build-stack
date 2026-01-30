FROM alpine:3.19

RUN apk add --no-cache bash curl ca-certificates

COPY deployer.sh /usr/local/bin/deployer.sh
RUN chmod +x /usr/local/bin/deployer.sh

ENTRYPOINT ["/usr/local/bin/deployer.sh"]
