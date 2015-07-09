'use strict';

require('loadenv')('net-proxy:env');

var net = require('net');
var dgram = require('dgram');
var express = require('express');
var bodyParser = require('body-parser');
var uuid = require('uuid');
var Boom = require('boom');
var bunyan = require('bunyan');
var util = require('util');
var bunyanExpressLogger = require('express-bunyan-logger');
var isEmpty = require('101/is-empty');

//------------------------------------------------------------------------------

var log = bunyan.createLogger({
  name: 'net-proxy',
  streams: [
    {
      level: process.env.LOG_LEVEL,
      stream: process.stdout
    }
  ],
  serializers: bunyan.stdSerializers
});

//------------------------------------------------------------------------------

var proxies = {};
var tcp = {};

function createProxy(host, port, cb) {
  var id = [host, port].join(':');

  if (tcp[id]) {
    return;
  }

  var serverUUID = uuid.v4();

  tcp[id] = net.createServer(function (c) {
    log.info({
      proxy: {
        host: host,
        port: port
      },
      client: c.address()
    }, 'Proxy connection');
    var socket = net.createConnection({ host: host, port: port });
    socket.pipe(c);
    c.pipe(socket);
  });

  tcp[id].on('listening', function () {
    var serverModel = {
      id: serverUUID,
      remote: {
        host: host,
        port: port
      },
      port: tcp[id].address().port,
      tcpId: id
    };
    log.info(serverModel, 'Proxy created');
    proxies[serverUUID] = serverModel;
    cb(null, serverModel);
  });

  tcp[id].listen(0);
}

//------------------------------------------------------------------------------

var app = express();
app
  //.use(bunyanExpressLogger({ logger: log }))
  .use(bodyParser.json())
  .get('/proxy/:id', getProxy)
  .post('/proxy', newProxy)
  .delete('/proxy/:id', deleteProxy)
  .use(function (err, req, res, next) {
    if (!err) {
      err = Boom.notFound();
    }
    log.error({err: err}, err.message || 'Internal Server Error');
    res.status(err.output.statusCode || 500).send({
      status: "error",
      message: err.output.payload.message
    });
  });


var server = app.listen(process.env.SOCKET_API_PORT, function (err) {
  if (err) {
    log.error({ err: err}, 'Error starting Proxy API server.')
    process.exit(1);
  }
  log.info({ port: process.env.SOCKET_API_PORT }, 'Proxy API started');
});

function getProxy(req, res, next) {
  var server = proxies[req.params.id];
  if (!server) {
    return next(Boom.notFound('Could not find proxy with id: ' + req.params.id));
  }
  log.info({ server: server }, 'Found server');
  res.status(200).send(server);
}

function newProxy(req, res, next) {
  var host = req.body.host;
  if (!host || isEmpty(host)) {
    return next(Boom.badRequest('Invalid remote host'));
  }

  var port = parseInt(req.body.port);
  if (isNaN(port)) {
    return next(Boom.badRequest('Invalid remote port: ' + req.body.port));
  }

  log.info({ host: host, port: port }, 'Creating proxy server');

  createProxy(host, port, function (err, server) {
    if (err) {
      return next(Boom.wrap(err));
    }
    res.status(200).send(server);
  });
}

function deleteProxy(req, res, next) {
  var server = proxies[req.params.id];
  if (!server) {
    next(Boom.notFound());
  }

  log.info({ server: server }, 'Deleting TCP proxy server');

  tcp[server.tcpId].close();
  delete tcp[server.tcpId];
  delete proxies[server.id];
  res.status(200).end();
}
