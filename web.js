var twilio = require('twilio');
var express = require('express');
var logfmt = require('logfmt');
var moment = require('moment');
var db = require('./db');
require('dotenv').config();

var app = express();

// Express Middleware
app.use(logfmt.requestLogger());
app.use(express.json());
app.use(express.urlencoded());
app.use(express.cookieParser(process.env.COOKIE_SECRET));
app.use(express.cookieSession());


// Serve testing page on which you can impersonate Twilio
// (but not in production)
if (app.settings.env === 'development') {
  app.use(express.static('public'))
}

// Allows CORS
app.all('*', function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "X-Requested-With");
  next();
});

// Enable CORS support for IE8.
app.get('/proxy.html', function(req, res) {
  res.send('<!DOCTYPE HTML>\n' + '<script src="http://jpillora.com/xdomain/dist/0.6/xdomain.min.js" master="http://www.courtrecords.alaska.gov"></script>');
});

app.get('/', function(req, res) {
  res.status(200).send('Hello, I am Courtbot. I have a heart of justice and a knowledge of court cases.');
});

// Fuzzy search that returns cases with a partial name match or
// an exact citation match
app.get('/cases', function(req, res) {
  if (!req.query || !req.query.q) return res.send(400);

  db.fuzzySearch(req.query.q, function(err, data) {
    // Add readable dates, to avoid browser side date issues
    data.forEach(function(d) {
      d.readableDate = moment(d.date).format('dddd, MMM Do');
    });

    res.send(data);
  });
});

function askedReminderMiddleware(req, res, next) {
  console.log("In middleware, text: " + req.body.Body)
  if (isResponseYes(req.body.Body) || isResponseNo(req.body.Body)) {
    if (req.session.askedReminder) {
      req.askedReminder = true;
      req.match = req.session.match;
      return next();
    }
    db.findAskedQueued(req.body.From, function (err, data) {  // Is this a response to a queue-triggered SMS? If so, "session" is stored in queue record
      if (err) return next(err);
      console.log("db.findAskedQueue result: " + JSON.stringify(data) + "data.length: " + data.length);
      if (data.length == 1) { //Only respond if we found one queue response "session"
        req.askedReminder = true;
        req.match = data[0];
      }
      next();
    });
  }
  else {
    next();
  }
}

// Respond to text messages that come in from Twilio
app.post('/sms', askedReminderMiddleware, function(req, res, next) {
  var twiml = new twilio.TwimlResponse();
  var text = req.body.Body.toUpperCase();

  if (req.askedReminder) {
    console.log("Text: " + text);
    if (isResponseYes(text)) {
      db.addReminder({
        caseId: req.match.id,
        phone: req.body.From,
        originalCase: JSON.stringify(req.match)
      }, function(err, data) {});
      console.log("Ready to send message");
      twiml.sms('(1/2) Sounds good. We will attempt to text you a courtesy reminder the day before your case. Note that case schedules frequently change.');
      twiml.sms('(2/2) You should always confirm your case date and time by going to ' + process.env.COURT_PUBLIC_URL);
      req.session.askedReminder = false;
      res.send(twiml.toString());
    } else {
      twiml.sms('OK. You can always go to ' + process.env.COURT_PUBLIC_URL + ' for more information about your case and contact information.');
      req.session.askedReminder = false;
      res.send(twiml.toString());
    }
    return;
  }

  if (req.session.askedQueued) {
    console.log("In askedQueued");
    if (isResponseYes(text)) {
      db.addQueued({
        citationId: req.session.citationId,
        phone: req.body.From
      }, function(err, data) {
        if (err) {
          next(err);
        }
        twiml.sms('OK. We will keep checking for up to ' + process.env.QUEUE_TTL_DAYS + ' days. You can always go to ' + process.env.COURT_PUBLIC_URL + ' for more information about your case and contact information.');
        req.session.askedQueued = false;
        res.send(twiml.toString());
      });
      return;
    } else if (isResponseNo(text)) {
      twiml.sms('OK. You can always go to ' + process.env.COURT_PUBLIC_URL + ' for more information about your case and contact information.');
      req.session.askedQueued = false;
      res.send(twiml.toString());
      return;
    }
  }

  console.log("Heading for findCitation");
  db.findCitation(text, function(err, results) {
    // If we can't find the case, or find more than one case with the citation
    // number, give an error and recommend they call in.
    if (!results || results.length === 0 || results.length > 1) {
      var correctLengthCitation = 6 <= text.length && text.length <= 25;
      if (correctLengthCitation) {
        twiml.sms('(1/2) Could not find a case with that number. It can take several days for a case to appear in our system.');
        twiml.sms('(2/2) Would you like us to keep checking for the next ' + process.env.QUEUE_TTL_DAYS + ' days and text you if we find it? (reply YES or NO)');

        req.session.askedQueued = true;
        req.session.citationId = text;
      } else {
        console.log("Got here somehow");
        twiml.sms('Couldn\'t find your case. Case identifier should be 6 to 25 numbers and/or letters in length.');
      }
    } else {
      var match = results[0];
      var name = cleanupName(match.defendant);
      var date = moment(match.date).format('ddd, MMM Do');


      twiml.sms('Found a case for ' + name + ' scheduled on ' + date + ' at ' + moment("1980-01-01 " + match.time).format("h:mm A") +', at ' + match.room +'. Would you like a courtesy reminder the day before? (reply YES or NO)');

      req.session.match = match;
      req.session.askedReminder = true;
    }


    res.send(twiml.toString());
  });
});

var cleanupName = function(name) {
  name = name.trim();

  // Change FIRST LAST to First Last
  name = name.replace(/\w\S*/g, function(txt) { return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(); });

  return name;
};

function isResponseYes(text) {
  text = text.toUpperCase();
  return (text === 'YES' || text === 'YEA' || text === 'YUP' || text === 'Y');
}
function isResponseNo(text) {
  text = text.toUpperCase();
  return (text === 'NO' || text ==='N');
}

// Error handling Middleware
app.use(function (err, req, res, next) {
  if (!res.headersSent) {
    // during development, return the trace to the client for
    // helpfulness
    console.log("Error: " + err.message);
    if (app.settings.env !== 'production') {
      return res.status(500).send(err.stack)
    }

    return res.status(500).send('Sorry, internal server error')
  }
});

var port = Number(process.env.PORT || 5000);
app.listen(port, function() {
  console.log("Listening on " + port);
});

module.exports = app;
