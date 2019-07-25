/* Middleware functions */
module.exports = {
  cleanupTextMiddleWare,
  stopMiddleware,
  yesNoMiddleware,
  deleteMiddleware,
  currentRequestMiddleware,
  caseIdMiddleware
};

/**
 * Strips line feeds, returns, and emojis from string and trims it
 *
 * @param  {String} text incoming message to evaluate
 * @return {String} cleaned up string
 */
function cleanupTextMiddleWare(req, res, next) {
  let text = req.body.Body.replace(/[\r\n|\n].*/g, "");
  req.body.Body = emojiStrip(text)
    .trim()
    .toUpperCase();
  next();
}

/**
 * Checks for 'STOP' text. We will recieve this if the user requests that twilio stop sending texts
 * All further attempts to send a text (inlcuding responing to this text) will fail until the user restores this.
 * This will delete any requests the user currently has (alternatively we could mark them inactive and reactiveate if they restart)
 */
function stopMiddleware(req, res, next) {
  const stop_words = [
    "STOP",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT"
  ];
  const text = req.body.Body;
  if (!stop_words.includes(text)) return next();

  db.deactivateRequestsFor(req.body.From)
    .then(case_ids => {
      res[action_symbol] = "stop";
      return res.sendStatus(200); // once stopped replies don't make it to the user
    })
    .catch(err => next(err));
}

/**
 *  Handles cases when user has send a yes or no text.
 */
function yesNoMiddleware(req, res, next) {
  // Yes or No resonses are only meaningful if we also know the citation ID.
  if (!req.session.case_id) return next();

  const twiml = new MessagingResponse();
  if (isResponseYes(req.body.Body)) {
    db.addRequest({
      case_id: req.session.case_id,
      phone: req.body.From,
      known_case: req.session.known_case
    })
      .then(() => {
        twiml.message(
          req.session.known_case
            ? messages.weWillRemindYou()
            : messages.weWillKeepLooking()
        );
        res[action_symbol] = req.session.known_case
          ? "schedule_reminder"
          : "schedule_unmatched";
        req.session = null;
        req.session = null;
        res.send(twiml.toString());
      })
      .catch(err => next(err));
  } else if (isResponseNo(req.body.Body)) {
    res[action_symbol] = "decline_reminder";
    twiml.message(
      req.session.known_case
        ? messages.repliedNo()
        : messages.repliedNoToKeepChecking()
    );
    req.session = null;
    res.send(twiml.toString());
  } else {
    next();
  }
}

/**
 * Handles cases where user has entered a case they are already subscribed to
 * and then type Delete
 */
function deleteMiddleware(req, res, next) {
  // Delete response is only meaningful if we have a delete_case_id.
  const case_id = req.session.delete_case_id;
  const phone = req.body.From;
  if (!case_id || req.body.Body !== "DELETE") return next();
  res[action_symbol] = "delete_request";
  const twiml = new MessagingResponse();
  db.deactivateRequest(case_id, phone)
    .then(() => {
      req.session = null;
      twiml.message(messages.weWillStopSending(case_id));
      res.send(twiml.toString());
    })
    .catch(err => next(err));
}

/**
 * Responds if the sending phone number is alreay subscribed to this case_id=
 */
function currentRequestMiddleware(req, res, next) {
  const text = req.body.Body;
  const phone = req.body.From;
  if (!possibleCaseID(text)) return next();
  db.findRequest(text, phone)
    .then(results => {
      if (!results || results.length === 0) return next();

      const twiml = new MessagingResponse();
      // looks like they're already subscribed
      res[action_symbol] = "already_subscribed";
      req.session.delete_case_id = text;
      twiml.message(messages.alreadySubscribed(text));
      res.send(twiml.toString());
    })
    .catch(err => next(err));
}

/**
 * If input looks like a case number handle it
 */
function caseIdMiddleware(req, res, next) {
  const text = req.body.Body;
  if (!possibleCaseID(text)) return next();
  const twiml = new MessagingResponse();

  db.findCitation(req.body.Body)
    .then(results => {
      if (!results || results.length === 0) {
        // Looks like it could be a citation that we don't know about yet
        res[action_symbol] = "unmatched_case";
        twiml.message(messages.notFoundAskToKeepLooking());
        req.session.known_case = false;
        req.session.case_id = text;
      } else {
        // They sent a known citation!
        res[action_symbol] = "found_case";
        twiml.message(messages.foundItAskForReminder(results[0]));
        req.session.case_id = text;
        req.session.known_case = true;
      }
      res.send(twiml.toString());
    })
    .catch(err => next(err));
}
