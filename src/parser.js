// initialize RabbitMQ connection
const Queue = require("./rabbitmq");
// create Exchange, Queue, Binding for Trackinops reQueue
Queue.initTopology().then(function () {
  // initialize workers
  Queue.startParserSubscriptions();
});