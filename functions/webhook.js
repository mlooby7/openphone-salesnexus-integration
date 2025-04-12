// functions/webhook.js
const axios = require('axios');

exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the OpenPhone webhook payload
    const payload = JSON.parse(event.body);
    console.log('Received webhook from OpenPhone:', payload);

    // Extract the relevant data
    const phoneData = payload.data.object;
    
    // Determine the phone number based on call direction
    const phoneNumber = phoneData.direction === 'incoming' ? phoneData.from : phoneData.to;
    
    // Clean the phone number (remove non-numeric chars except leading +)
    let formattedPhoneNumber = phoneNumber;
    if (phoneNumber.startsWith('+')) {
      formattedPhoneNumber = '+' + phoneNumber.substring(1).replace(/\D/g, '');
    } else {
      formattedPhoneNumber = phoneNumber.replace(/\D/g, '');
    }
    
    // Log for debugging
    console.log(`Original phone: ${phoneNumber}, Formatted phone: ${formattedPhoneNumber}`);
    
    // Use permanent API key for SalesNexus
    const apiKey = process.env.SALESNEXUS_API_KEY;
    console.log('Using permanent API key for authentication');
    
    // Try multiple phone formats for searching
    const phoneFormats = [
      formattedPhoneNumber,
      formattedPhoneNumber.replace(/^\+1/, ''),  // Without country code
      formattedPhoneNumber.replace(/^\+/, '')    // No plus sign
    ];
    
    let contactId = null;
    
    // Try each phone format
    for (const phoneFormat of phoneFormats) {
      console.log(`Trying phone format: ${phoneFormat}`);
      
      // Search for contacts with this phone number
      const searchResponse = await axios.post('https://logon.salesnexus.com/api/call-v1', [{
        "function": "get-contacts",
        "parameters": {
          "api-key": apiKey,
          "filter-field": "35",
          "filter-value": phoneFormat,
          "start-after": "0",
          "page-size": "50"
        }
      }]);
      
      // Check if we found matching contacts
      if (searchResponse.data[0].result && 
          searchResponse.data[0].result['contact-list'] && 
          searchResponse.data[0].result['contact-list'].length > 0) {
        // Use the first matching contact
        contactId = searchResponse.data[0].result['contact-list'][0]['contact-id'];
        console.log(`Found matching contact with ID: ${contactId}`);
        break;
      }
    }
    
    // If no contact found with any phone format, use fallback
    if (!contactId) {
      contactId = process.env.FALLBACK_CONTACT_ID;
      console.log(`No matching contact found. Using fallback ID: ${contactId}`);
    }
    
    // Format note details based on available data
    let noteType, noteDetails;
    
    // Determine what kind of data we have (recording, summary, transcript)
    if (phoneData.media && phoneData.media[0] && phoneData.media[0].url) {
      // Call Recording
      noteType = "Recording";
      noteDetails = `Call Recording from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(phoneData.createdAt).toLocaleString()}\n` +
                   `Direction: ${phoneData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${phoneData.media[0].duration || 0} seconds\n\n` +
                   `Recording URL: ${phoneData.media[0].url}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${phoneData.id}`;
    } else if (phoneData.call_summary) {
      // Call Summary
      noteType = "Summary";
      noteDetails = `Call Summary from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(phoneData.createdAt).toLocaleString()}\n` +
                   `Direction: ${phoneData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${phoneData.duration_seconds || 0} seconds\n\n` +
                   `Summary: ${phoneData.call_summary}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${phoneData.id}`;
    } else if (phoneData.call_transcript) {
      // Call Transcript
      noteType = "Transcript";
      noteDetails = `Call Transcript from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(phoneData.createdAt).toLocaleString()}\n` +
                   `Direction: ${phoneData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${phoneData.duration_seconds || 0} seconds\n\n` +
                   `Transcript: ${phoneData.call_transcript}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${phoneData.id}`;
    } else {
      // Generic call note
      noteType = "Call";
      noteDetails = `Call from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(phoneData.createdAt).toLocaleString()}\n` +
                   `Direction: ${phoneData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${phoneData.duration_seconds || 0} seconds\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${phoneData.id}`;
    }
    
    // Create note in SalesNexus
    const noteResponse = await axios.post('https://logon.salesnexus.com/api/call-v1', [{
      "function": "create-note",
      "parameters": {
        "api-key": apiKey,
        "contact-id": contactId,
        "details": noteDetails,
        "type": "1"
      }
    }]);
    
    console.log('Note creation response:', noteResponse.data);
    
    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Successfully processed OpenPhone webhook",
        contactId: contactId,
        noteType: noteType
      })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Error processing webhook",
        details: error.message
      })
    };
  }
};
