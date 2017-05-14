# mondego
Development support systems to Elasticsearch data migration

## How to run
* Checkout this repo
* Run npm install
* Create a config.json file (example below)
* Run node mondego.js config.json

### Configuration
```json
{
  "elasticsearch": {
    "url": "https://somewhere",
    "ciindex": "build",
    "vcsindex": "repo"
  },
  "jenkins": {
    "url": "https://bigus_dicus:hunter2@somewhere/jenkins"
  },
  "gitlab": {
    "url": "https://somewhere/api/v3",
    "username": "bigus_dicus",
    "password": "hunter2"
  }
}
```
