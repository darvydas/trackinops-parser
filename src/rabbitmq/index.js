// start MongoDB with Mongoose
const mongoose = require('mongoose');
mongoose.Promise = require('bluebird'); // Use bluebird promises

const crawlerModel = require('../models/crawlerModel');
// const executionModel = require('../models/executionModel');
const requestModel = require('../models/requestModel');

const _ = require('lodash');
const topology = require("./topology.js");
// insert configuration file
const config = require('../../configuration.js')(process.env.NODE_ENV);

mongoose.connect(config.mongodb.uri, config.mongodb.options);

const CDP = require('chrome-remote-interface');

const cheerio = require('cheerio');
const Promise = require('bluebird');
const URL = require('url');
const dns = require('dns');
const dnscache = require('dnscache')({
  "enable": true,
  "ttl": 300,
  "cachesize": 1000
});

// Rabbot is a module to simplify RabbitMQ control
const rabbit = require('rabbot');

rabbit.on("connected", function (connection) {
  console.log(`RabbitMQ connected!! Event trigger for ${connection.name}`);
  // rabbit.retry(); // retry to connect
});
rabbit.on("unreachable", function (connection) {
  console.log(`RabbitMQ connection is unreachable Event trigger for ${connection.name}`);
  rabbit.retry(); // retry to connect
});
rabbit.on("failed", function (connection) {
  console.log(`RabbitMQ connection failed Event trigger for ${connection.name}`);
  rabbit.retry(); // retry to connect
});
rabbit.on("closed", function (connection) {
  console.log(`RabbitMQ connection closed (intentional) Event trigger for ${connection.name}`);
  rabbit.retry(); // retry to connect
});

const initTopology = function () {
  return crawlerModel.find().then(function (docs) {

    return topology(rabbit, docs)
      .then(function () {
        console.info('RabbitMQ connection started');
      }).catch(function (err) {
        console.error('RabbitMQ configuration failed', err);
      });
  }).catch(function (err) {
    console.error('MongoDB crawlerModel search failed', err);
  });
}

const publishCrawlerRequest = function (url, uniqueUrl, executionDoc) {
  return rabbit.publish("trackinops.crawler-request-router", {
    routingKey: 'crawler.' + executionDoc.crawlerCustomId + '.execution.' + executionDoc._id,
    type: 'crawler.' + executionDoc.crawlerCustomId + '.execution.' + executionDoc._id,
    messageId: uniqueUrl,
    body: {
      url: url,
      uniqueUrl: uniqueUrl,
      executionDoc: executionDoc,
      timestamp: Date.now()
    },
    timestamp: Date.now(),
    expiresAfter: 1000 * 60 * 60 * 24 * 7 // 7 days
  }, config.rabbit.connection.name)
    .then(function () {
      console.info('Published to RabbitMQ, execution._id =', executionDoc._id);
    });
}

/**
* @public
*  // @paramm {String} routingKey - where to requeue
*  // @paramm {String} type = routingKey - by default for crawler requests bindings
* @param {MongoId} requestsId
* @param {*} bodyData - data to include in a message
* @returns {Promise}
*
*/

const publishMessageRequeue = function (bodyData, publishedMessageId) {
  let self = this;
  return new Promise(function (resolve, reject) {
    if (_.isUndefined(bodyData)) { return reject(new Error('Message bodyData is undefined')) }
    // bodyData.timestamp = Date.now();
    return rabbit.publish("trackinops.crawler-message-router", {
      routingKey: 'Requeue.crawler_requeue',
      type: 'Requeue.crawler_requeue',
      messageId: publishedMessageId,
      body: // bodyData,
      {
        urlList: bodyData.urlList,
        executionDoc: bodyData.executionDoc,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      expiresAfter: 1000 * 60 * 60 * 24 * 7 // 7 days
    }, config.rabbit.connection.name)
      .then(function () {
        console.info('Message requeued to RabbitMQ, messageId =', publishedMessageId);
        resolve(publishedMessageId);
      });
  });
}

const startParserSubscriptions = function () {
  let self = this;
  return crawlerModel.find().then(function (MongoCrawlerDocs) {
    // creating queues and bindings for all of the crawlers in MongoDB  
    _.each(_.keys(MongoCrawlerDocs), function (key) {
      // for (let i = 1; i <= MongoCrawlerDocs[key].maxParallelRequests; i++) {
      rabbit.handle({
        queue: 'Parser.' + MongoCrawlerDocs[key].crawlerCustomId,
        type: 'parser.' + MongoCrawlerDocs[key].crawlerCustomId + '.#'
      }, function (msg) {
        console.info("Received:", msg.body.url, "routingKey:", msg.fields.routingKey);
        // // if (job.id % 10 == 0) { // changes Tor IP if it's 10th consecutive job starting
        // //   tr.renewTorSession(function (err, res) {
        // //     if (err) console.error(err);
        // //   });
        // // }

        // const nightmareBrowser = new Nightmare({
        //   executionTimeout: 10, // in ms
        //   webPreferences: {
        //     images: msg.body.executionDoc.loadImages ? true : false
        //   },
        //   // switches: {
        //   //   'proxy-server': 'localhost:8118' // polipo http proxy for Tor
        //   // },
        //   show: true, // true/false - showing a loading browser
        //   ignoreSslErrors: false,
        //   webSecurity: false // disable same origin policy
        // });
        return new Promise((resolve, reject) => {
          CDP.New(function (err, target) {
            if (err) return reject(err);
            console.info('New CDP Target', target);
            resolve(target);
          });
        })
          .then((target) => {
            return CDP({ tab: target })
              .then((client) => {
                // Extract used DevTools domains.
                const { Page, Runtime, Network, Security } = client;

                // extract from page Object and starting values
                const extractedResults = {};
                extractedResults.queuedAt = msg.body.timestamp;
                extractedResults.crawlMatches = [];
                extractedResults.downloadedBytes = 0;

                const getLoadedPageUrl = () => {
                  // Evaluate browser window location URL.
                  return new Promise((resolve, reject) => {
                    Runtime.evaluate({ expression: 'window.location.href' }).then((result) => {
                      // console.info('window.location.href', result.result.value);
                      resolve(result.result.value);
                    });
                  });
                };
                const getLoadedPageHTML = () => {
                  return new Promise((resolve, reject) => {
                    // Evaluate HTML.
                    Runtime.evaluate({ expression: 'document.documentElement.innerHTML' }).then((result) => {
                      console.info('document.documentElement.innerHTML', result.result.value.length);
                      resolve(result.result.value);
                    });
                  })
                };
                const getLoadedPageReferrer = () => {
                  return new Promise((resolve, reject) => {
                    // Evaluate page referrer.
                    Runtime.evaluate({ expression: 'document.referrer' }).then((result) => {
                      // console.info('document.referrer', result.result.value);
                      resolve(result.result.value);
                    });
                  });
                };
                const extractFromPage = Promise.method(() => {
                  // Evaluate function chain to extract all of the needed data from page.
                  return Promise.all([
                    getLoadedPageUrl(),
                    getLoadedPageHTML(),
                    getLoadedPageReferrer()
                  ])
                    // return getLoadedPageUrl()
                    //   .then((loadedUrl) => {
                    //     console.log('loadedUrl', loadedUrl);
                    //     extractedResults.loadedUrl = loadedUrl;
                    //     return getLoadedPageHTML();
                    //   })
                    //   .then((html) => {
                    //     console.log('html.length', html.length);
                    //     extractedResults.html = html;
                    //     extractedResults.htmlLength = html.length;
                    //     return getLoadedPageReferrer();
                    //   })
                    //   .then((referrer) => {
                    //     console.log('referrer', referrer);
                    //     // console.log(extractedResults);
                    //     return extractedResults.referrer = referrer;
                    //   })
                    .then((received) => {
                      // console.log('received', received);
                      extractedResults.loadedUrl = received[0];
                      extractedResults.html = received[1];
                      extractedResults.htmlLength = received[1].length;
                      extractedResults.referrer = received[2];
                      return Promise.resolve(extractedResults);
                    });
                });
                const elementIsOnThePage = (selector) => {
                  return new Promise((resolve, reject) => {
                    // Evaluate outerHTML.
                    Runtime.evaluate({ expression: `document.documentElement.querySelector("${selector}")` })
                      .then((result) => {
                        console.info(`document.documentElement.querySelector("${selector}")`, result);
                        if (result && result.result && result.result.value) resolve(true);
                        resolve(false);
                      });
                  })
                };
                const endChromeTab = (tabId) => {
                  console.info('Chromium Tab is closing!!!');
                  return CDP.Close({ id: tabId }, function (err) {
                    if (err) return console.error(`Closing Chrome Tab have failed with ${err.message}`);
                    console.info(`Chrome Tab ${tabId} have been closed.`);
                  });
                };

                const ignoreCertificateEvents = () => {
                  // ignore all the certificate errors
                  return Security.certificateError(({ eventId }) => {
                    return Security.handleCertificateError({
                      eventId,
                      action: 'continue'
                    });
                  });
                }
                const allowToContinue = (request) => {
                  const { host } = URL.parse(request.url);
                  console.log(request.url);
                  console.log(host);
                  console.log('/' + msg.body.executionDoc.followLinks.crawlerUrlRegex + '/');
                  console.log(request.url.match('/' + msg.body.executionDoc.followLinks.crawlerUrlRegex + '/'));
                  return new RegExp('^' + msg.body.executionDoc.followLinks.crawlerUrlRegex + '$').test(request.url);
                }
                const requestInterceptedEvents = () => {
                  // intercept requests
                  return Network.requestIntercepted(({ interceptionId, request }) => {
                    // perform a test against the intercepted request
                    let allowed = allowToContinue(request);
                    console.log(`- ${allowed ? 'ALLOW' : 'BLOCK'} ${request.url}`);
                    return Network.continueInterceptedRequest({
                      interceptionId,
                      errorReason: allowed ? undefined : 'Aborted'
                    });
                  });
                }
                const loadingFailedEvents = () => {
                  return Network.loadingFailed(params => {
                    console.log('*** loadingFailed: ', params);
                    // console.log('*** loadingFailed: ', params.blockedReason);
                  })
                }
                const loadingFinishedEvents = () => {
                  return Network.loadingFinished(params => {
                    console.log('<-', params.requestId, params.encodedDataLength);
                  })
                }
                const requestWillBeSentEvents = () => {
                  return Network.requestWillBeSent((params) => {
                    if (params.request.url === msg.body.url) {
                      // console.log('requestWillBeSent', params);
                      extractedResults.method = params.request.method;
                      extractedResults.loadingStartedAt = params.wallTime * 1000;
                    }
                    console.log(`-> ${params.requestId} ${params.request.url.substring(0, 150)}`);
                  });
                }
                const dataReceivedEvents = () => {
                  return Network.dataReceived((params) => {
                    // console.log('dataReceived', params);
                    extractedResults.downloadedBytes += params.dataLength;
                  });
                }
                const responseReceivedEvents = () => {
                  return Network.responseReceived((params) => {
                    if (params.response.url === msg.body.url) {
                      // console.log('responseReceived', params);
                      extractedResults.responseStatus = params.response.status;
                      extractedResults.responseHeaders = params.response.headers;
                      extractedResults.loadingTimeMs = params.response.timing.receiveHeadersEnd;
                    }
                  });
                }

                // Enable events on domains we are interested in.
                return Promise.all([
                  Network.enable(),
                  Page.enable(),
                  Security.enable()
                ])
                  .then(() => {
                    // Network and Security domain settings
                    return Promise.all([
                      Security.setOverrideCertificateErrors({ override: true }),
                      Network.setUserAgentOverride({ userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }),
                      // Network.setBlockedURLs({ urls: msg.body.executionDoc.requestBlockList }),
                      // Network.enableRequestInterception({ enabled: true }),
                      Network.setCacheDisabled({ cacheDisabled: true })
                    ])
                  })
                  .then(() => {
                    // set Network and Security events
                    return Promise.all([
                      ignoreCertificateEvents(),
                      loadingFailedEvents(),
                      loadingFinishedEvents(),
                      // requestInterceptedEvents(),
                      requestWillBeSentEvents(),
                      dataReceivedEvents(),
                      responseReceivedEvents()
                    ])
                  })
                  .then(() => {
                    return Page.navigate({ url: msg.body.url });
                  })
                  .then(() => {
                    return new Promise((resolve, reject) => {
                      Page.loadEventFired().then(() => {
                        // console.log('Page.loadEventFired');
                        // return extractFromPage()
                        //   .then((result) => resolve)
                        //   .catch((err) => { console.log(err); return endChromeTab(target.id) });
                        return resolve(extractFromPage());
                      });
                    })
                      .then((result) => {
                        //   return getAllLinksFromHtml(
                        //     extractedResults.html,
                        //     msg.body.url,
                        //     msg.body.executionDoc.followLinks.elementSelector,
                        //     msg.body.executionDoc.followLinks.action);
                        // })
                        // .then(function (allLinks) {
                        //   extractedResults.allLinks = allLinks;
                        //   return filterUrlListByRegex(allLinks, msg.body.executionDoc.followLinks.crawlerUrlRegex);
                        // })
                        // .then((followLinks) => {
                        //   extractedResults.followingLinks = followLinks;

                        return Promise.all(msg.body.executionDoc.crawlMatches.map(function (cMatch) {
                          let regexMatch = false;

                          if (!cMatch.urlRegEx) return cMatch;

                          if (cMatch.urlRegEx !== null && cMatch.urlRegEx.length > 0) {
                            // replaces [] to ()
                            let matchStr = cMatch.urlRegEx.replace(/\[/g, '(').replace(/\]/g, ')');
                            if (_.endsWith(matchStr, '/')) {
                              // removes trailing slash
                              matchStr = matchStr.substring(0, matchStr.length - 1);
                            }
                            let patt = new RegExp('^' + matchStr + '$');
                            if (_.endsWith(extractedResults.loadedUrl, '/')) {
                              extractedResults.loadedUrl = extractedResults.loadedUrl.substring(0, extractedResults.loadedUrl.length - 1);
                            }
                            regexMatch = patt.test(extractedResults.loadedUrl);
                          }
                          if (regexMatch) return cMatch;

                        }))
                          .then(function (crawlMatchesAfterRegexCheck) {
                            // evaluate elements on the page
                            const regexMatched = _.compact(crawlMatchesAfterRegexCheck);
                            console.info(msg.body.url, 'regexMatched', regexMatched);
                            // if regexMatched match is empty just return an empty array
                            if (regexMatched.length === 0) return regexMatched;

                            return Promise.all(regexMatched.map(function (cMatch) {

                              if (!cMatch.waitForSelector) // regex matches URL and waitForSelector is not specified
                                return cMatch;

                              // regex matches URL and waitForSelector found on the page
                              return elementIsOnThePage(cMatch.waitForSelector)
                                .then((existOnPagee) => {
                                  return existOnPagee ? cMatch : false
                                });

                            })).then(function (crawlMatchesAfterRegexCheck) {
                              // return full array of crawlMatches
                              // if nothing matched for all waitForSelector's, still return empty
                              let crawlMatchesFounded = _.compact(crawlMatchesAfterRegexCheck);
                              console.log(msg.body.url, 'crawlMatchesFounded', crawlMatchesFounded);
                              return crawlMatchesFounded;

                            });

                          });
                      })
                      .then(function (crawlMatches) {
                        return extractedResults.crawlMatches = crawlMatches;
                      })
                      .then(function () {
                        return queueProcessParserAndMongoSave(msg.body, extractedResults);
                      })
                      .then(function (uniqueUrl) { // uniqueUrl = String, or undefined if message publishing failed
                        // TODO: add random delay before finishing the job to emulate human crawling (it will slow down another job request)

                        msg.ack(); // the job have been finished
                        return endChromeTab(target.id);
                      })
                      .catch((err) => {
                        console.error(`ERROR: ${err.message}`);

                        // TODO: consider requeuing the message before cancelling forever
                        // msg.ack(); // finishes the job with error
                        // msg.reject(); // finishes the job and don't reque the message
                        // msg.nack(); // returns message to queue to run again
                        if (err)
                          console.error(err); // JSON.stringify(error))); // done(new Error(JSON.stringify(error)));

                        // saving failed any failed request to MongoDB
                        return requestModel.upsertAfterError(
                          {
                            // Mongoose creating object to DB
                            errorInfo: err,

                            queuedAt: msg.body.timestamp,
                            uniqueUrl: msg.body.uniqueUrl,
                            url: msg.body.url,
                            executionId: msg.body.executionDoc._id
                          }).finally(() => {
                            console.error('Crawling failed error saved to Requests Collection', upsertResponse);

                            msg.ack(); // finishes the job and saves error
                            endChromeTab(target.id);
                          });
                      });
                  }).catch((err) => {
                    console.error("Chrome err", err);
                    msg.nack(); // Chrome Browser failed return message to queue to run again
                  });
              }).catch((err) => {
                console.error("CDP err", err);
                msg.nack(); // Chrome Browser failed return message to queue to run again
              });
          }).catch((err) => {
            console.error("CDP.new err", err);
            msg.nack(); // Chrome Browser failed return message to queue to run again
          });
      }).catch(function (err, msg) {
        // do something with the error & message
        msg.nack();

        if (err)
          console.error(new Error(err));

        // saving failed any failed request to MongoDB
        return requestModel.upsertAfterError(
          {
            // Mongoose creating object to DB
            errorInfo: err,

            requestedAt: msg.body.timestamp,
            uniqueUrl: msg.body.uniqueUrl,
            url: msg.body.url,
            executionId: msg.body.executionDoc._id
          }).then(function (upsertResponse) {
            console.error('Crawling failed error saved to Requests Collection', upsertResponse);
          }).catch(function (lastError) {
            console.error('lastError', lastError);
          });
      });


      // if (i === MongoCrawlerDocs[key].maxParallelRequests) {
      //   console.info("Created", i, "rabbit handlers for", MongoCrawlerDocs[key].crawlerCustomId);
      // }

      console.info("Created", "rabbit handlers for", MongoCrawlerDocs[key].crawlerCustomId);

      // }

    });

  }).catch(function (err) {
    console.error('MongoDB crawlerModel search failed', err);
  });
}

function queueProcessParserAndMongoSave(requestMessageBody, result) {
  return new Promise(function (resolve, reject) {

    return pageParser(result).then(function (parserResult) {
      let insertParserResult = parserResult || {};

      return requestModel.upsertAfterParser(
        {
          // Mongoose updating object to DB
          executionId: requestMessageBody.executionDoc._id,
          url: requestMessageBody.url,
          uniqueUrl: requestMessageBody.uniqueUrl,
          loadedUrl: result.loadedUrl,

          queuedAt: result.queuedAt,
          loadingStartedAt: result.loadingStartedAt,
          loadingTimeMs: result.loadingTimeMs,

          responseStatus: result.responseStatus,
          responseHeaders: result.responseHeaders,
          method: result.method,

          pageMatched: result.crawlMatches,

          pageMatched: result.crawlMatches,
          parserStartedAt: insertParserResult.parserStartedAt,
          parserFinishedAt: insertParserResult.parserFinishedAt,
          parserResult: insertParserResult.parserResult,

          referrer: result.referrer,
          downloadedBytes: result.downloadedBytes,
          html: {
            toLength: result.htmlLength,
            toString: result.html
            // allLinks: result.allLinks,
            // followingLinks: result.followingLinks
          }
        }).then(function (request) {
          if (!request) reject(new Error(`requestModel.upsertAfterParser conditions have not been met. executionId: ${requestMessageBody.executionDoc._id},  uniqueUrl: ${requestMessageBody.uniqueUrl}`));
          console.info('completed job saved to DB, requestId = ', request._id);
          // // publishing result.followingLinks to message requeue
          // return Queue.publishMessageRequeue({
          //   urlList: result.followingLinks,
          //   executionDoc: requestMessageBody.executionDoc
          // }, requestMessageBody.uniqueUrl)
          //   .then(function (messageId) {
          //     // console.info(queuedUrlList);
          //     return resolve(messageId);
          //   })
          //   .catch(function (err) {
          //     console.error(new Error(`Queue.publishMessageRequeue failed ${err.message}`));
          //     // if requeue of links from the page failed 
          //     // still let the current handler finish without errors
          return resolve();
          // });
        }, function (err) {
          console.error(new Error('job completed - mongo save - error on request ' + err));
          reject(new Error('job completed - mongo save - error on request ' + err));
        });
    })
  })
}

function pageParser(result) {
  return new Promise(function (resolve, reject) {
    if (result.crawlMatches.length < 1) return resolve(); // nothing to parse, return empty

    const pageParserReturns = {};
    pageParserReturns.parserStartedAt = Date.now();
    let $ = cheerio.load(result.html);

    // iterates over all the crawlMatches and returns array matched results
    return Promise.map(result.crawlMatches, function (resultCMatch, index, length) {
      if (_.isEmpty(resultCMatch.parser)) return resolve(); // no data from the page is needed
      // iterates over each key in resultCMatch.parser and returns an array of single resultCMatch
      return Promise.map(_.keys(resultCMatch.parser), function (selectorName) {
        let singleResult = {};
        switch (selectorName) {
          case 'path':
            singleResult[selectorName] = '>>';
            singleResult[selectorName] += $(resultCMatch.parser[selectorName]).map(function (i, el) {
              // this === el
              return $(this).attr('href');
            }).get().join('>>');
            break;
          case 'image':
            constructUrl($(resultCMatch.parser[selectorName]).first().attr('src'), result.loadedUrl)
              .then(function (fullUrl) {
                singleResult[selectorName] = fullUrl;
              });
            break;
          case 'description':
            singleResult[selectorName] = $(resultCMatch.parser[selectorName]).first().html();
            break;
          default: // 'name', 'sku', 'priceCurrent','productId','categoryId','currency' and everything else
            singleResult[selectorName] = $(resultCMatch.parser[selectorName]).first().text();
        }
        return singleResult;
      }).then(function (singleResult) {
        // do something with single array of matching elements
        // TODO: check if any of the elements are undefined, means that the page matched, but the extract failed
        return {
          "pageType": resultCMatch.pageType,
          "data": singleResult.reduce(function (result, item) { // returns object instead of array of objects
            var key = Object.keys(item)[0]; //first property: a, b, c
            result[key] = item[key];
            return result;
          }, {})
        };
      });
    }).then(function (parserResults) {
      // do something with all of the parserResults array
      pageParserReturns.parserFinishedAt = Date.now();
      pageParserReturns.parserResult = parserResults;
      return resolve(pageParserReturns);
    })
  }).catch(function (err) {
    console.error(new Error('Error on pageParser ' + err));
  });

}

function getAllLinksFromHtml(html, urlString, elementSelector, action) {
  return new Promise(function (resolve, reject) {

    let url = URL.parse(urlString);
    if (!url.host) reject(new Error('function getAllLinksFromHtml -> url.host is not specified'));
    if (!elementSelector) reject(new Error('function getAllLinksFromHtml -> elementSelector is not specified ' + urlString));
    if (!action) reject(new Error('function getAllLinksFromHtml -> action is not specified ' + urlString));

    let links = [];
    let $ = cheerio.load(html);
    $('script').remove(); // removes <script></script> tags

    $(elementSelector).each(function (i, e) {
      let linkObject = {};
      switch (action) {
        // get link from element href attribute (ex: a[href])
        case 'getHref': linkObject = URL.parse($(this).attr('href'));
      }

      if (!linkObject.protocol) {
        // set default extracted link protocol
        linkObject.protocol = 'http:';
      }

      // skip any other protocols (mailto:, tel:, ftp:, etc.)
      if (linkObject.protocol == 'http:' || linkObject.protocol == 'https:') {

        if (!linkObject.host && !linkObject.pathname
          && (linkObject.search || linkObject.hash)
          && url.host) {
          // adding extracted link host and pathname for internal links "?page=2" or "#something"
          linkObject.host = url.host;
          linkObject.pathname = url.pathname
        }

        // if extracted link hasn't got host, usually it means that it's internal link with skipped hostname
        if (!linkObject.host && url.host) {
          // set default host from the given url
          linkObject.host = url.host;
        }

        return links.push(URL.format(linkObject));
      }
    });
    resolve(_.uniq(links));
  });
}

function filterUrlListByRegex(urlList, crawlerUrlRegex) {

  let pattern = new RegExp(crawlerUrlRegex, 'i'); // url filter locator
  return urlList.filter(function (singleUrl) {
    return pattern.test(singleUrl);
  });
}

function getLinksFromHtml(html, urlString, followLinksSetting) {
  return new Promise(function (resolve, reject) {

    let url = URL.parse(urlString);
    if (!url.host) reject(new Error('function getLinksFromHtml -> url.host is not specified'));
    if (!followLinksSetting) reject(new Error('function getLinksFromHtml -> followLinksSetting is not specified ' + urlString));
    if (followLinksSetting && !followLinksSetting.elementSelector) reject(new Error('function getLinksFromHtml -> elementSelector is not specified ' + urlString));
    if (followLinksSetting && !followLinksSetting.crawlerUrlRegex) reject(new Error('function getLinksFromHtml -> crawlerUrlRegex is not specified ' + urlString));

    let links = [];
    let $ = cheerio.load(html);
    $('script').remove(); // removes <script></script> tags

    $(followLinksSetting.elementSelector).each(function (i, e) {
      let linkObject = {};
      switch (followLinksSetting.action) {
        // get link from element href attribute (ex: a[href])
        case 'getHref': linkObject = URL.parse($(this).attr('href'));
      }

      if (!linkObject.protocol) {
        // set default extracted link protocol
        linkObject.protocol = 'http:';
      }

      // skip any other protocols (mailto:, tel:, ftp:, etc.)
      if (linkObject.protocol == 'http:' || linkObject.protocol == 'https:') {

        if (!linkObject.host && !linkObject.pathname
          && (linkObject.search || linkObject.hash)
          && url.host) {
          // adding extracted link host and pathname for internal links "?page=2" or "#something"
          linkObject.host = url.host;
          linkObject.pathname = url.pathname
        }

        // if extracted link hasn't got host, usually it means that it's internal link with skipped hostname
        if (!linkObject.host && url.host) {
          // set default host
          linkObject.host = url.host;
        }

        // given url and extracted link hostnames and ports matches
        if (linkObject.host === url.host) {
          let link = URL.format(linkObject);
          // check the extracted link by the given filter RegEx
          let pattern = new RegExp('^' + followLinksSetting.crawlerUrlRegex + '$', 'i'); // fragment locator
          if (pattern.test(link)) return links.push(URL.format(linkObject));
        }
      }
    });
    resolve(_.uniq(links));
  });
}

function isValidUrlByDNSHost(url) {
  return new Promise(function (resolve, reject) {
    host = URL.parse(url, true).host; // https://nodejs.org/api/url.html#url_url_parse_urlstring_parsequerystring_slashesdenotehost
    return dnscache.lookup(host, { family: 4 }, // https://nodejs.org/api/dns.html#dns_dns_lookup_hostname_options_callback
      function (err, address, family) {
        if (err) reject(new Error(url + ' is not valid URL'));
        console.info('isValidUrlByDNSHost; url: %j address: %j family: IPv%s', url, address, family);
        return resolve(url);
      })
  });
}

// not used any more, changed to isValidUrlByDNSHost
// function isValidUrlByRegex(url) {
//   // TODO: sometimes url can be encoded like http%3A//domain.com, regex should deal with it
//   let pattern = new RegExp('^(https?:\\/\\/)+' + // protocol
//     '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // domain name
//     '((\\d{1,3}\\.){3}\\d{1,3}))' + // OR ip (v4) address
//     '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port and path
//     '(\\?[;&a-z\\d%_.~+=-]*)?' + // query string
//     '(\\#[-a-z\\d_]*)?$', 'i'); // fragment locator
//   return new Promise(function (resolve, reject) {
//     if (!pattern.test(url)) {
//       // not valid url is rejected
//       return reject(new Error(url + ' is not valid URL'));
//     } else {
//       return resolve(url);
//     }
//   });
// }

function constructUrl(url, urlConstructor) {
  return new Promise(function (resolve, reject) {
    let urlObject = URL.parse(url);
    // return URL.parse(url).then(function (urlObject) {
    let urlConstructorObject = URL.parse(urlConstructor);

    if (!urlConstructorObject.host) reject(new Error("Second argument urlConstructor haven't got host"));

    if (!urlObject.protocol) {
      // set default URL protocol
      urlObject.protocol = 'http:';
    }

    // skip any other (mailto:, tel:, ftp:, etc.)
    if (urlObject.protocol == 'http:' || urlObject.protocol == 'https:') {

      if (!urlObject.host
        && !urlObject.pathname
        && (urlObject.search || urlObject.hash)) {
        // adding url host and pathname for internal hrefs "?page=2" or "#something"     
        urlObject.host = urlConstructorObject.host;
        urlObject.pathname = urlConstructorObject.pathname
      }

      // if url hasn't got host, usually it means that it's internal url the with skipped main part of the url
      if (!urlObject.host) {
        // set default host
        urlObject.host = urlConstructorObject.host;
      }

      resolve(URL.format(urlObject));
    } else reject(new Error("First argument's url.protocol != http/https"));
  });
}

exports = module.exports = Queue = {
  initTopology: initTopology,
  startParserSubscriptions: startParserSubscriptions,
  publishCrawlerRequest: publishCrawlerRequest,
  publishMessageRequeue: publishMessageRequeue
};
