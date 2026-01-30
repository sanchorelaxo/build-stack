FROM jenkins/jenkins:lts

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    unzip \
  && rm -rf /var/lib/apt/lists/*

ARG SONAR_SCANNER_VERSION=5.0.1.3006
RUN curl -fsSL -o /tmp/sonar-scanner.zip \
    "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-linux.zip" \
  && unzip -q /tmp/sonar-scanner.zip -d /opt \
  && rm -f /tmp/sonar-scanner.zip \
  && ln -s "/opt/sonar-scanner-${SONAR_SCANNER_VERSION}-linux" /opt/sonar-scanner

COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli -f /usr/share/jenkins/ref/plugins.txt

COPY jobs/ /usr/share/jenkins/ref/jobs/
COPY init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/

USER jenkins
