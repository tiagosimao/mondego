const jobRunner = require('./logic');

const no_delay = 0;
const long_delay = 1000;

let stop;

module.exports.sync = function(mondego){
    return new Promise((ff,rj)=>{
      mondego.forEachDriver(driver=>{
        const workers = driver.workers ? driver.workers : 1;
        for(let i=0;i<workers;++i){
          fireConsumer(mondego,driver,no_delay);
        }
      });
      mondego.loadState();
    });
};

function fireConsumer(mondego,driver,delay){
  setTimeout(
    ()=>{
      if(stop){
        console.log("Shutting down driver " + driver.id);
        return;
      }
      mondego.pickupJob(driver.id).then(
        job=>{
          jobRunner.run(driver,job).then(
            nextJobs=>{
              //console.info("Completed job " + job.method + " on driver " + driver.id);
              if(nextJobs){
                nextJobs.onDriver.forEach(j=>{
                  mondego.queueJob(driver.id,j);
                });
                nextJobs.onDestination.forEach(j=>{
                  mondego.queueJob("destination-driver",j);
                });
              }
              mondego.resolveJob(driver.id,job);
              mondego.saveState();
              fireConsumer(mondego,driver,no_delay);
            },
            ko=>{
              console.error("Error running job " + job.method + " on driver " + driver.id + ": " + ko);
              mondego.rejectJob(driver.id,job);
              fireConsumer(mondego,driver,long_delay);
            }
          );
        },
        jobless=>fireConsumer(mondego,driver,long_delay));
      }
    ,delay);
}
