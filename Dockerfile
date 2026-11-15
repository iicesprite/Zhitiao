FROM node:24-alpine
WORKDIR /app
RUN mkdir -p /state && chown node:node /state
COPY server ./server
ENV HOST=0.0.0.0 PORT=8787 ZHITIAO_DB=/state/zhitiao.sqlite
VOLUME ["/state"]
USER node
EXPOSE 8787
CMD ["node", "server/http.cjs"]
