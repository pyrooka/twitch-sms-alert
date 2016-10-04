
const request = require('request');
const redis = require('redis');
const twilio = require('twilio');
const util = require('util');


// Application settings.
// Twilio account secure ID.
var twilioAccountSid;
// Twilio API secure ID.
var twilioApiSid;
// Twilio API secret.
var twilioApiSecret;
// Sender phone number of the sms notification.
var smsSenderPhoneNumber;
// Your twitch secret aka client-id.
var twitchClientId;
// Object what contains the phone numbers to send sms.
var smsReciversPhoneNumberArray;
// Channels what we are following.
var followingChannelNamesArray;
// Redis db uri
var redisUri;
// Number of the sms have to send.
var smsCounter;
// Send sms when the cannel goes offline.
var sendWhenOffline;

// SMS messages.
const goLiveMessage = '%s is streaming %s from %s.';
const goOfflineMessage = '%s goes offline!';

// Redis client.
var redisClient;


// Create URL for the specified channel.
function createUrl(channelName) {
  return 'https://api.twitch.tv/kraken/streams/' + channelName
}

// Initialize the enviornment variables.
function init() {
  twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  twilioApiSid = process.env.TWILIO_API_SID;
  twilioApiSecret = process.env.TWILIO_API_SECRET;
  smsSenderPhoneNumber = process.env.SMS_SENDER_PHONE_NUMBER;
  // Get the phone numbers as an array
  smsReciversPhoneNumberArray = process.env.NOTIFICATION_PHONE_NUMBERS.split(',');
  twitchClientId = process.env.TWITCH_CLIENT_ID;
  // Get the channels name as an array
  followingChannelNamesArray = process.env.CHANNEL_NAMES.split(',');
  redisUri = process.env.REDIS_URL;
  sendWhenOffline = process.env.SEND_WHEN_OFFLINE;
  // Set the 'have to send' sms number from the smsReciversPhoneNumberArray multiply by the channels number.
  smsCounter = smsReciversPhoneNumberArray.length * followingChannelNamesArray.length;
}

// Send sms via Twilio
function sendSms(fromNumber, toNumber, message, callback) {
  // Authenticate a new twilio REST client.
  var sender = new twilio.RestClient(twilioApiSid, twilioApiSecret).accounts(twilioAccountSid);
  // Create then send an sms.
  sender.messages.create({
      to: toNumber,
      from: fromNumber,
      body: message
  }, function(err, message) {
  	if (err) {
      setImmediate(callback, new Error('Cannot send the sms to the number: ' + fromNumber + ' Error: ' + err.code));
    } else {
      setImmediate(callback, null, 'SMS sent! SID: ' + message.sid);
    }
  });
}

// Create message content.
function createMessageContent(isOnline, channelName, response) {
  // Message content.
  var message;
  if (isOnline) {
    message = util.format(goLiveMessage, response.stream.channel.display_name,
                              response.stream.game, response.stream.created_at.split('T')[1].replace('Z',''));
  } else {
    message = util.format(goOfflineMessage, channelName);
  }

  return message;
}

// Send sms to all of the telephone numbers specified in the config
function sendSmsToUsers(isOnline, channelName, response, callback) {
  // If set to zero or false don't send sms if the channel is offline.
  if (!isOnline) {
    setImmediate(callback, null, 'Offline but don\'t send because of the settings.')
  }
  // Create the sms message content.
  var messageContent = createMessageContent(isOnline, channelName, response);
  // Iterated through the phone numbers.
  for (var i = 0; i < smsReciversPhoneNumberArray.length; ++i) {
    // Send sms to each number in the array.
    sendSms(smsSenderPhoneNumber, smsReciversPhoneNumberArray[i], messageContent, function(err, res) {
      if (err) {
        setImmediate(callback, new Error(err));
      }
      if (res) {
        setImmediate(callback, null, res);
      }
    });
  }
}

// Check the channel. If online return true otherwise false,
function checkChannel(channelName, callback) {
  // The request object.
  var requestOptions = {
    url: createUrl(channelName),
    headers: {
      'Client-ID': twitchClientId
    }
  };
  // Get response from the twitch api.
  request(requestOptions, function(error, response, body) {
    // If no response from the server.
    if (!response) {
      setImmediate(callback, new Error('No response from the server.'));
    }
    // If empty body in the response
    else if (!body) {
      setImmediate(callback, new Error('Empty body in the response.'));
    } else {
      // Parse the body string to JSON.
      var bodyObj = JSON.parse(body);
      // If online true otherwise false;
      var isOnline = bodyObj.stream ? true : false;
      console.log(isOnline);
      // Let the function decide shoud we send sms to users.
      shouldSendSms(channelName, isOnline, bodyObj, function(err, res) {
        if (err) {
          setImmediate(callback, err);
        }
        if (res) {
          setImmediate(callback, null, res);
        }
      });
    }
  });
}

// Connect to redis
function connectToRedis(callback) {
  try {
    // Create the client.
    redisClient = redis.createClient(redisUri);
  } catch (ex){
    setImmediate(callback, new Error('Cannot create redis client. Exception: ' + ex));
    return;
  }
  // Connect to the db.
  redisClient.on('ready', function() {
    setImmediate(callback, null);
  });

  redisClient.on('error', function(err) {
    setImmediate(callback, err);
  });

}

// Check old and new status of the cannel in the db
function shouldSendSms(channelName, isOnline, bodyObj, callback) {
  redisClient.getset(channelName, isOnline, function (err, resp) {
    // If get error, finish the function.
    if (err) {
      setImmediate(callback, new Error('Error occured while trying to getset to the redis db.'))
      return;
    }

    // If no error let's send sms if the status changed.
    if (isOnline.toString() !== resp) {
      // Send sms based on change (from true to false or from false to true).
      sendSmsToUsers((isOnline === true && resp === 'false'), channelName, bodyObj, function(err, res) {
        if (err) {
          setImmediate(callback, err);
        } else {
          setImmediate(callback, null, res)
        }
      });
    } else {
      // No change.
      // Because we won't iterate through all of the number we have to set the smsCounter to zero manually.
      setSmsCountZero();
      setImmediate(callback, null, 'Status didn\'t change for: ' + channelName + ' Still ' + resp + '.');
    }
  });
}

// Check the sent sms number. Can we close the db and quit now?
function checkSmsCount() {
  // Minus one from the current because we get a response (error or res nevermind).
  smsCounter -= 1;
  // If there is no sms left,
  if (smsCounter <= 0) {
    // close the db connection.
    redisClient.quit();
  }
}

// Set the 'have to send' sms count to zero.
function setSmsCountZero() {
  smsCounter = 0;
}

// Start the script.
function start() {
  // Init the enviornment variable.
  init();
  // First connect to redis.
  console.log('Connecting to the db...');
  // Create connection to the db.
  connectToRedis(function(err) {
    if (err) {
      console.error('ERROR: ' + err.toString());
    } else {
      console.log('Connected to redis db.');
      // Iterates through the given channel names.
      for (var i = 0; i < followingChannelNamesArray.length; ++i) {
        if (!followingChannelNamesArray[i]) {
          console.error('ERROR: Invalid channel name at: ' + i);
        } else {
          checkChannel(followingChannelNamesArray[i], function(err, res) {
            if (err) {
              console.error(err.toString());
              checkSmsCount();
            } else {
              console.log(res.toString());
              checkSmsCount();
            }
          });
        }
      }
    }
  });
}

// Start the script.
start()
