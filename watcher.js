'use strict';

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
var smsReceiversPhoneNumberArray;
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
  smsReceiversPhoneNumberArray = process.env.NOTIFICATION_PHONE_NUMBERS ? process.env.NOTIFICATION_PHONE_NUMBERS.split(',') : [];
  twitchClientId = process.env.TWITCH_CLIENT_ID;
  // Get the channels name as an array
  followingChannelNamesArray = process.env.CHANNEL_NAMES ? process.env.CHANNEL_NAMES.split(',') : [];
  redisUri = process.env.REDIS_URL;
  sendWhenOffline = process.env.SEND_WHEN_OFFLINE ? true : false;
  // Set the 'have to send' sms number from the smsReceiversPhoneNumberArray multiply by the channels number.
  smsCounter = smsReceiversPhoneNumberArray.length * followingChannelNamesArray.length;
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
                              response.stream.game, getTimeOnly(response.stream.created_at));
  } else {
    message = util.format(goOfflineMessage, channelName);
  }

  return message;
}

// Send sms to all of the telephone numbers specified in the config
function sendSmsToUsers(isOnline, channelName, response, callback) {
  // If we don't want to send SMS if the user became offline.
  if (!sendWhenOffline && !isOnline) {
    setImmediate(callback, null, 'Offline but don\'t send because of the settings.');
    return;
  }
  // Create the sms message content.
  var messageContent = createMessageContent(isOnline, channelName, response);
  // Iterated through the phone numbers.
  for (var i = 0; i < smsReceiversPhoneNumberArray.length; ++i) {
    // Send sms to each number in the array.
    sendSms(smsSenderPhoneNumber, smsReceiversPhoneNumberArray[i], messageContent, function(err, res) {
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
    // Error occurred.
    if (error) {
      setImmediate(callback, error);
    }
    // If no response from the server.
    else if (!response) {
      setImmediate(callback, new Error('No response from the server.'));
    }
    // If empty body in the response.
    else if (!body) {
      setImmediate(callback, new Error('Empty body in the response.'));
    } else {
      var bodyObj = null;
      try {
        // Parse the body string to JSON.
        bodyObj = JSON.parse(body);
      } catch (ex) {
        setImmediate(callback, new Error('Invalid body JSON.'));
        return;
      }

      // If online true otherwise false;
      var isOnline = bodyObj.stream ? true : false;
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
  redisClient.getset(channelName, isOnline, function(err, resp) {
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

// Add leading zero if num parameter is a digit. 
function fixLeadingZero(num){
  if(num < 10)
    return '0'+ num;
  else
    return num + '';
}

// Add two hour to the current time, because of the timezones.
function getTimeOnly(date) {
  var fullDate = new Date(date);
  // Add plus two hour.
  var newDate = new Date(fullDate.getTime() + 2*60*60*1000);
  var currentHours = fixLeadingZero(newDate.getHours());
  var currentMinutes = fixLeadingZero(newDate.getMinutes());
  var currentSeconds = fixLeadingZero(newDate.getSeconds());

  // Create the string with the hours, minutes and seconds only.
  var timeString = currentHours + ':' + currentMinutes + ':' + currentSeconds;

  return timeString;
}

// Start the script.
function start() {
  // Init the environment variables.
  init();

  // Make some basic validations.
  if (followingChannelNamesArray.length === 0) {
    console.error('ERROR: Please specify the channels to watch.');
  }
  else if (smsReceiversPhoneNumberArray.length === 0) {
    console.error('ERROR: Please specify the phone numbers which will receive the SMS alerts.');
  }
  else if (!redisUri) {
    console.error('ERROR: Please specify the Redis server to connect.');
  }
  else if (!twilioAccountSid || !twilioApiSid || !twilioApiSecret) {
    console.error('ERROR: Please specify all the Twilio credentials.');
  }
  else if (!smsSenderPhoneNumber) {
    console.error('ERROR: Please specify the SMS sender phone number.');
  }
  else if (!twitchClientId) {
    console.error('ERROR: Please specify the Twitch Client-ID.');
  } else {
    // Everything looks good.

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
}

// Start the script.
start()
