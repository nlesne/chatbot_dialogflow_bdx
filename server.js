// server.js

// init project
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const dialogflow = require('dialogflow');
const assets = require('./assets');
const structjson = require('structjson');
const expressSession = require('express-session');
const FileStore = require('session-file-store')(expressSession);

const parseString = require('xml2js').parseString;
const fs = require('fs');
require('events').EventEmitter.defaultMaxListeners = 15;

const neo4j = require('neo4j-driver').v1;
const uri = 'bolt://localhost:7687';
const driver = neo4j.driver(uri, neo4j.auth.basic("neo4j", "chatbot"));
const session = driver.session();

const dialogflow_api = require('./dialogflow-admin-api');
const UE = require('./UE');
const Licence = require('./Licence');
const Semestre = require('./Semestre');

const projectLanguageCode = 'fr-FR';
const projectId = 'formation-bdx';
const info_base_url = 'https://www.u-bordeaux.fr/formation/2018/PRLIIN_110/informatique/enseignement/';
const GOOGLE_CLOUD_AUTH_FILE = "auth_file.json";

app.use(expressSession({
      store: new FileStore("./.sessions/"),
      secret: '%]N.]x5QYP?3xH2C',
      resave: true,
      saveUninitialized: true,
      messages: []
    })
);

app.use(express.static('public'));
app.use("/assets", assets);

//Used to parse POST requests
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

app.get('/', function (request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

app.get('/admin', function (req, res) {
  initChatbot()
  .then(() => {
    res.sendStatus(200);
  })
  .catch((err) => {
    console.log(err);
    res.sendStatus(500);
  })
});

// listen for requests
const listener = app.listen('8080', function () {
  console.log(
      'Rendez vous sur la page web suivante pour converser avec le chatbot: http://localhost:8080');

});

app.post('/sendMsg', function (request, response) {
  const messageContent = request.body.message;
  let currentSession = request.sessionID;
  console.log("SessionID = " + currentSession);
  detectTextIntent(projectId, currentSession, messageContent,
      projectLanguageCode)
      .then(dialogflowResponse => {
        var botMessage = dialogflowResponse[0].queryResult.fulfillmentMessages[0].text.text[0];
        console.log("Response = " + botMessage);
        response.send(botMessage);
      });
});

function detectTextIntent(projectId, sessionId, query, languageCode) {
  // [START dialogflow_detect_intent_text]

  // Instantiates a session client
  const sessionClient = new dialogflow.SessionsClient(
      {keyFilename: GOOGLE_CLOUD_AUTH_FILE});

  if (!query) {
    return;
  }

  // The path to identify the agent that owns the created intent.
  const sessionPath = sessionClient.sessionPath(projectId, sessionId);
  console.log(sessionPath);

  let promise;

  // Detects the intent of the query
  // The text query request.
  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: query,
        languageCode: languageCode,
      },
    },
  };

  if (!promise) {
    // First query.
    console.log(`Sending query "${query}"`);
    promise = sessionClient.detectIntent(request);

  } else {
    promise = promise.then(responses => {
      console.log('Detected intent');
      const response = responses[0];

      // Use output contexts as input contexts for the next query.
      response.queryResult.outputContexts.forEach(context => {
        // There is a bug in gRPC that the returned google.protobuf.Struct
        // value contains fields with value of null, which causes error
        // when encoding it back. Converting to JSON and back to proto
        // removes those values.
        context.parameters = structjson.jsonToStructProto(
            structjson.structProtoToJson(context.parameters)
        );
      });
      request.queryParams = {
        contexts: response.queryResult.outputContexts,
      };

      console.log(`Sending query "${query}"`);
      return sessionClient.detectIntent(request);
    });
  }
  return promise;

  // [END dialogflow_detect_intent_text]

}

async function initChatbot() {
  await clearBdd();
  await readXML();
  let ueList = await getAllUE();
  await generateEntityType(ueList);
  let trainingPhrases = [];
  for (let ue of ueList) {
    let UETrainingPhrases = await generateTrainingPhrases(ue);
    trainingPhrases.push(UETrainingPhrases);
  }
  await createFormationIntent(trainingPhrases);


  driver.close();
  session.close();
}

function readXML() {

  console.log("readXML... ");

  let Info = new Licence('PRLIIN_110', 'Informatique', session);

  return new Promise((resolve, reject) => {

    /*if (typeof process.argv[2] === "undefined") {
      console.log("AIDE: node parser.js {fichier XML à parser}");
    }
    else {*/

      Info.addBdd().then( () => {

        var keywords = [];
        fs.readFile('keywords', 'utf-8', function (err, buf) {
          if (err) throw err;
          var lineReader = require('readline').createInterface({ input: require('fs').createReadStream('keywords') });
          lineReader.on('line', function (line) {
            keywords.push(line);
          });
        });

        fs.readFile("formation_licence_info.xml", 'utf-8', function (err, buf) {
          var j=0;

          if (err) throw err;
          parseString(buf, function (err, result) {
            (result.CDM['ns3:program']).forEach(program => {
              var nature = (program["ns2:programDescription"])[0].$.nature;
              if (nature === "semestre") {
                (((program["ns2:programStructure"])[0])['ns2:refProgram']).forEach(id => {
                  var name = ((((program['ns2:programName'])[0])['ns2:text'])[0]._);
                  if ((name.toUpperCase().includes("SEMESTRE 5"))||(name.toUpperCase().includes("SEMESTRE 6"))) {
                    (result.CDM['ns3:program']).forEach(program => {
                      if ((program["ns3:programID"])[0]._ === id.$.ref) {
                        program['ns2:programStructure'].forEach(structure => {
                          structure['ns2:refCourse'].forEach(courseID => {
                            var courseIDTmp = courseID.$.ref;
                            result.CDM['ns3:course'].forEach( (element, index) => {
                              if (((element['ns3:courseID'])[0]._) === courseIDTmp) {
                                var courseName = (((element['ns3:courseName'])[0]._).replace(/\n|\r/g, ""));
                                if (typeof ((element['ns3:learningObjectives'])[0]._) !== "undefined") {
                                  var description = (((element['ns3:learningObjectives'])[0]._));
                                  description = description.replace(".", " ");
                                  var splitDescription = description.split(' ');
                                  var keywordsFound = [];
                                  keywords.forEach(keyword => {
                                    if (keyword.split(' ').length<=1){
                                      for (var i = 0; i < splitDescription.length; i++) {
                                        if (splitDescription[i].includes("'")) {
                                          splitDescription[i] = splitDescription[i].substr(splitDescription[i].indexOf("'"), splitDescription[i].length);
                                          splitDescription[i] = splitDescription[i].replace("'", "");
                                        }
                                        if (splitDescription[i].toUpperCase() === keyword.toUpperCase() && keywordsFound.indexOf(keyword) === -1) {
                                          keywordsFound.push(splitDescription[i]);
                                        }
                                      }

                                    }
                                    else{
                                      if (description.toUpperCase().includes(keyword.toUpperCase()) && keywordsFound.indexOf(keyword) === -1) {
                                        keywordsFound.push(keyword);
                                      }
                                    }
                                  });
                                }
                                else {
                                   description = courseName;
                                }

                                let semestre = new Semestre(name,
                                    session);
                                let ue = new UE(courseIDTmp, courseName,
                                    description, keywordsFound,
                                    session);

                                semestre.addBdd().then(() => {
                                  semestre.linkTo(Info.name).then(() => {

                                    ue.addBdd().then(() => {

                                      ue.linkTo(semestre.name).then(
                                          () => {

                                            if (index + 1 === result.CDM['ns3:course'].length) {
                                              console.log("Fin readXML !!");
                                              resolve();
                                            }
                                          });

                                    }).catch((err) => {
                                      console.log(err);
                                    });
                                  })
                                });
                              }
                            });
                          });
                        });
                      }
                    });
                  }
                });
              }
            });
          });
        });

      })

    //}

  });
}

function clearBdd() {

  console.log("clear...");

  return new Promise((resolve, reject) => {
    clearRelations().then(() => {

      clearNode().then(() => {
        resolve();
      }).catch((err) => {
        reject(err);
      })

    }).catch((err) => {
      reject(err);
    })
  });

}

function clearRelations() {

  return new Promise((resolve, reject) => {

    clearUERelation().then(() => {
      clearSemestreRelation().then(() => {
        resolve();
      }).catch((err) => {
        reject(err);
      })
    }).catch((err) => {
      reject(err);
    })
  })

}

function clearUERelation() {

  console.log("clear UE relations...");

  return new Promise((resolve, reject) => {
    const requestCypher = 'match ()-[r:isUE]->() delete r';

    const resultPromise = session.run(requestCypher);

    resultPromise.then(() => {

      console.log("clear UE relations terminé !");
      resolve();

    }).catch((err) => {
      reject(err);
    });
  });
}

function clearSemestreRelation() {

  console.log("clear Semestre relations...");

  return new Promise((resolve, reject) => {
    const requestCypher = 'match ()-[r:isSEMESTRE]->() delete r';

    const resultPromise = session.run(requestCypher);

    resultPromise.then(() => {

      console.log("clear Semestre relations terminé !");
      resolve();

    }).catch((err) => {
      reject(err);
    });
  });
}

function clearNode() {

  console.log("clear node...");

  return new Promise((resolve, reject) => {
    const requestCypher = 'match (a) delete a';

    const resultPromise = session.run(requestCypher);

    resultPromise.then(() => {
      console.log("clear node terminé !");
      resolve();

    }).catch((err) => {
      reject(err);
    });
  });
}

function getAllUE() {

  let tabUE = [];

  return new Promise((resolve, reject) => {
    const requestCypher = 'match (ue:UE) return ue';

    const resultPromise = session.run(requestCypher);

    resultPromise.then((result) => {

      for (let i = 0; i < result.records.length; i++) {

        //console.log(result.records[i].get(0).properties);
        tabUE.push(result.records[i].get(0).properties);

        if (i + 1 === result.records.length) {
          resolve(tabUE);
        }
      }
    }).catch((err) => {
      reject(err);
    });
  });
}

async function generateTrainingPhrases(UE, entityType) {
  console.log("Generating training phrases for " + UE.name + ":" + UE.id);
  const trainingPhrasesTemplates = [
    "Je veux faire $KEYWORD",
    "J'aimerais faire $KEYWORD",
    "Jvoudrais étudier $KEYWORD",
    "Je veux faire $KEYWORD pendant mes études"
  ];

  let trainingPhrases = [];
  for(let phraseTemplate of trainingPhrasesTemplates) {
    let splittedPhrase = phraseTemplate.split("$KEYWORD");
    let trainingPhraseParts = [];
    for (let split of splittedPhrase) {
      trainingPhraseParts.push({text: split});
    }
    trainingPhraseParts.splice(1,0,{
      text: UE.name,
      entityType: entityType,
      alias: entityType,
      userDefined: true
    });
    let trainingPhrase = {
      type: 'EXAMPLE',
      parts: trainingPhraseParts
    };
    trainingPhrases.push(trainingPhrase);
  }

  console.log("Generated training phrases");
  return trainingPhrases;

}

async function generateEntityType(UEList) {
  let entities = [];
  for (let UE of UEList) {
    let synonyms = UE.keywords;
    if (!synonyms)
      synonyms = [];
    synonyms.push(UE.name);
    let entity = {
      value: UE.name,
      synonyms: synonyms
    };
    entities.push(entity);
  }
  let entityType = {
    displayName: "UE",
    kind: "KIND_MAP",
    autoExpansionMode: "AUTO_EXPANSION_MODE_UNSPECIFIED",
    entities: entities
  };


  let entityTypeId = "";
  let entityTypes = await dialogflow_api.listEntityTypes(projectId);
  entityTypes.forEach((entityT) => {
    if (entityT.displayName === "UE") {
      entityTypeId = entityT.name;
    }
  });
  //try {
    //await dialogflow_api.deleteEntityType(projectId,entityTypeId);
  //}
  //catch (e) {
    //console.log(e);
    //await dialogflow_api.createEntityType(projectId, entityType);
  //}
  await dialogflow_api.createEntityType(projectId, entityType);
}

async function createFormationIntent(trainingPhrases) {
  let entityType = "UE";
  let intent = {
    displayName: "Requete_Formation",
    isFallback: false,
    trainingPhrases: trainingPhrases,
    messages: [{text: {text: ["$UE"]}}],
    parameters: [{
      displayName: entityType,
      entityTypeDisplayName: "@" + entityType,
      value: "$" + entityType
    }]

  };

  await dialogflow_api.createIntent(projectId, intent);
}

