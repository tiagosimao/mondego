const fs = require('fs');
const http = require('https');
const url = require('url');
const request = require('request');
const elasticsearch = require('elasticsearch');
const events = require('events');
const bus = new events.EventEmitter();

const moduleReadyEvent = "moduleReadyEvent";
const jenkinsReadyEvent = "jenkinsReadyEvent";

let writerReady = false;
let queuedReaders = [];

let config;
let elclient;


// QUEUE
function queue(reader) {
    queuedReaders.push(reader);
    bus.emit(moduleReadyEvent);
}

// READERS
function sync() {
    if(writerReady) {
        let reader;
        while(reader=queuedReaders.pop()) {
            reader();
        }
    }
}


// JENKINS
let jenkinsQueue = [];
let jenkinsWait = 100;
let jenkinsMaxWait = 60000;
let jenkinsCurrentWait = 0;

function readJenkinsQueue() {
    let call;
    if(call=jenkinsQueue.pop()) {
        call(()=>{
            jenkinsWait=Math.min(10000,jenkinsWait+100);
            setTimeout(readJenkinsQueue,jenkinsWait);
        },()=>{
            jenkinsWait=Math.max(jenkinsWait-100,0);
            setTimeout(readJenkinsQueue,jenkinsWait);
        });
    } else if(jenkinsCurrentWait<jenkinsMaxWait) {
        jenkinsCurrentWait+=100;
        setTimeout(readJenkinsQueue,100); // poll interval
    }
}

function jenkinsGet(path, reader) {
    jenkinsQueue.push((retry,next)=>{
        let callUri = url.resolve(config.jenkins.url,path);
        console.info("Calling Jenkins: " + path);
        request(url.format(callUri), (error,response,body)=>{
            try{
                if(error) {
                    console.error("Error getting data from Jenkins: " + callUri.path);
                    console.error(error);
                } else if(response && response.statusCode < 300) {
                    let data = JSON.parse(body);
                    reader(data);
                } else {
                    let cause = response ? response.statusCode : "unknown cause";
                    console.error("Error getting data from Jenkins: " + cause + " at " + path);
                }
            } finally {
                if(error || response && response.statusCode>499){
                    retry();
                } else {
                    next();
                }
            }
        });
    });
}

function findCulprit(data) {
    if(!data){
        return undefined;
    }
    if(data.userName){
        return data.userName;
    } else if(data.fullName) {
        return data.fullName;
    } else {
        Object.keys(data).forEach(function(k, i) {
            if(data == data[k] || !data.hasOwnProperty(k)) {
                return;
            }  else {
                let found = findCulprit(data[k]);
                if (found) {
                    return found;
                }
            }
        });
    }
    return undefined;
}

function syncPromotion(promotion,job) {
    var promotionUrl = url.parse(promotion.url);
    jenkinsGet(promotionUrl.path + "api/json",
        got=>{
            let buildNumber = got.target ? got.target.number : undefined;
            let promotionData = {
                "id": got.id,
                "repoName": job.name,
                "buildNumber": buildNumber,
                "duration": got.duration,
                "created_timestamp": new Date(got.timestamp).toISOString(),
                "status": got.result,
                "description": got.description,
                "url": got.url,
                "user": findCulprit(got)
            };
            write(config.elasticsearch.index, "release", promotionData.id + "", promotionData);
        }
    );
}

function syncProcess(process,job) {
    var processUrl = url.parse(process.url);
    jenkinsGet(processUrl.path + "api/json",
        got=>{
            for(let promotion of got.builds){
                syncPromotion(promotion,job);
            }
        }
    );
}

function syncPromotions(job) {
    var jobUrl = url.parse(job.url);
    jenkinsGet(jobUrl.path + "promotion/api/json",
        got=>{
            for(let process of got.processes){
                syncProcess(process,job);
            }
        }
    );
}

function syncBuilds(job) {
    for (var i in job.builds) {
        var build = job.builds[i];
        var buildUrl = url.parse(build.url);
        jenkinsGet(buildUrl.path + "api/json",
            function (jenkinsBuildData) {
                let buildData = {
                    "id": jenkinsBuildData.id,
                    "repoName": job.name,
                    "buildNumber": jenkinsBuildData.number,
                    "duration": jenkinsBuildData.duration,
                    "created_timestamp": new Date(jenkinsBuildData.timestamp).toISOString(),
                    "status": jenkinsBuildData.result,
                    "description": jenkinsBuildData.description,
                    "url": jenkinsBuildData.url,
                    "user": findCulprit(jenkinsBuildData)
                };
                write(config.elasticsearch.index, "build", buildData.id, buildData);
        });
    }
}

function syncJenkinsJobs() {
    jenkinsGet("api/json",
        (rootData) => {
            for(let jobSummary of rootData.jobs){
                var jobUrl = url.parse(jobSummary.url);
                jenkinsGet(jobUrl.path + "api/json",
                    (job) => {
                        syncBuilds(job);
                        syncPromotions(job);
                    });
            }
        });
}


// GITLAB
function gitlabGet(apiPath, reader, pageIndex, pageSize) {
    apiPath = apiPath.replace(/^\/|\/$/,'');
    let path = url.parse(config.gitlab.url+apiPath);
    if(pageIndex || pageIndex==0) {
        let search = path.search;
        if(search){
            search+="&";
        } else {
            search="?";
        }
        search+="page=" + pageIndex
        if(!pageSize){
            pageSize = 20;
        }
        search+="per_page=" + pageSize;
        path.search = search;
    }
    let options = {
        url: url.format(path),
        headers: {
            'PRIVATE-TOKEN': config.gitlab.private_token
        }
    };
    console.info("Calling Gitlab: " + options.url);
    request(options, function (error, response, body) {
        if(error) {
            console.error("Error getting data from Gitlab: " + error)
        }  else if (response && response.statusCode < 300) {
            let got = JSON.parse(body);
            if(got && Object.keys(got).length > 0) {
                reader(got);
                let nextPageIndex = response.headers["x-next-page"];
                if (!nextPageIndex) {
                    nextPageIndex = pageIndex ? (pageIndex + 1) : 1;
                }
                let suggestedPageSize = response.headers["x-per-page"];
                if (suggestedPageSize) {
                    pageSize = suggestedPageSize;
                }
                gitlabGet(apiPath, reader, nextPageIndex, pageSize);
            }
        } else {
            let cause = response ? response.satusCode : "unknown cause";
            console.error("Error getting data from Gitlab: " + options.url  + " (" + cause + ")")
        }
    });
}

function syncGitlabCommits(project) {
    gitlabGet("/projects/" + project.id + "/repository/commits",commits=>{
        for(let commit of commits) {
            let data = {
                "uid": commit.id,
                "repoName": project.name,
                "user": commit.author_email,
                "description": commit.title,
                "created_timestamp": commit.created_at
            };
            write(config.elasticsearch.index,"commit",commit.uid,data);
        }
    }, 0);
}

function syncGitlabProjects() {
    gitlabGet("/projects/",projects=>{
        for(let project of projects) {
            let data = {
                "id": project.id,
                "repoName": project.name,
                "description": project.description,
                "archived": project.archived,
                "created_timestamp": project.created_at,
                "activity_timestamp": project.last_activity_at
            };
            write(config.elasticsearch.index,"repo",project.id,data);
            syncGitlabCommits(project);
        }
    });
}

// WRITE DATA

function write(index, type, id, data) {
    console.info("Writing: " + index + "/" + type + "/" + id);
    elclient.index({
        index: index,
        type: type,
        id: id,
        body: data
    });
}

// SETUP MODULES

function setup() {
    setupJenkins();
    //setupGitlab();
    setupElasticsearch();
}

function setupElasticsearch() {
    elclient = new elasticsearch.Client({
        host: config.elasticsearch.url,
        log: 'info'
    });
    elclient.ping({
        requestTimeout: 1000
    }, function (error) {
        if (error) {
            console.error("Error connecting to Elasticsearch");
        } else {
            writerReady=true;
            bus.emit(moduleReadyEvent);
        }
    });
}

function setupJenkins() {
    if(!config.jenkins.url.endsWith('/')){
        config.jenkins.url+='/';
    }
    readJenkinsQueue();
    queue(syncJenkinsJobs);
}

function setupGitlab() {
    if(!config.gitlab.url) {
        console.error("No URL set for GitLab");
    }
    if(!config.gitlab.url.endsWith("/")){
        config.gitlab.url += "/";
    }
    request.post(
        config.gitlab.url + "/session?login="+config.gitlab.username+"&password=" + config.gitlab.password,
        function (error, response, body) {
            if (!error && response.statusCode < 300) {
                let got = JSON.parse(body);
                config.gitlab.private_token = got.private_token;
                if(config.gitlab.private_token) {
                    queue(syncGitlabProjects);
                } else {
                    console.error("Gitlab: Invalid authentication response");
                }
            } else {
                console.error("Gitlab: setup error: " + response.statusCode);
            }
        }
    );
}

// BOOTSTRAP
function loadConfig(configLocation) {
    config = JSON.parse(fs.readFileSync(configLocation, encoding="utf-8"));
}

function boot() {
    let configLocation = process.argv[2];
    if(!configLocation) {
        console.error("usage: node mondego.js <config file location>")
    } else {
        loadConfig(configLocation);
        bus.on(moduleReadyEvent,()=>{
            sync();
        });
        setup();

    }
}
boot();