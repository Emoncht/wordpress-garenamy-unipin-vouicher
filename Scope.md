the credentials are default and database name is unipin.

We will use Mysql instead of sqllite.

Let me tell about the updated flow,

part 1 - 
Lets create a batch system, Order number will be the batch ID. Quantity will be the total topup process in the batch, We will store Order Id, Uid, Voucher, Voucher denomation.  status, total try, Reason,  Screenshot Url, Validated Uid,  Created at, Completed At.



Default status for each batch will be Pending, When topup request recieves We will check if the batch allready exist, If exist then we will return 
completed voucher
Consumed voucher
Voucher yet to be processed 


If not then we will return

{
    "status": true,
    "message": "Order received. 1 vouchers have been added to the processing queue.",
    "order_id": "3321444",
    "total_vouchers_queued": 1
    Queue number - 5 
}
in json format


Part 2  (how to update the table  )
When a voucher will be processed for a Order ID, Status will be updated as Submitting. Since we have three browser instance running we can simultaniously can process 3 vouchers, right?
after a Process completed we will update the status As Completed and store screenshot and transaction ID= Use ABCD for now, I will tell you later how to find it. 
If a voucher is consumed we will store the status As Consumed
Else We will update the status as failed And in the reason field we will store the reason.



For the validated Uid it will be null when order created, We will enter the validated uid we get from const verificationUrl (when we are calling multi endpoint)

uid validation process
- Instead of getting Player ID directly from response we will get the player Id and other data from our database tables now. It will check every 10 seconds if a voucher with pending/failed status exist, If yes it will continue to Complete topup for that voucher, After each voucher for a batch status is Completed or Consumed we will send the final response to our callback url, Response structure will be the same. We will entry each retry in the retry table, maximum 5 retries for each vouchers. 

Rate Limit- 
Create table in our database, in the database add a row named rate limit - yes
When rate limit shows we will update it as yes.
After 35 seconds we will update rate limit as No


 Before opening browser, clicking any elements it will check everytime if rate limit=yes 
 If yes it will not proceed to next step. Our full script will be stop, After rate limit update as No We will refresh the browsers and continue the process again.


You can understand the rest. IF you do not understand anything or confused you will   ask me... 


As for the ORDER  endpoint  we will send response with these data, so that we can get a clear view.
 Change the structure

{
    "status": true,
    "message": "Order in queue, Currently processing orders 217042",
    "queue_number": 1,
    "unprocessed_voucher": 2,
    "completed_voucher": 1,
    "consumed_voucher": 3,
    "currently_processing": [
        "217042"
    ],
    "queue_length": 5
}


I repeat if you are confused ask me question. 


Make sure do not change any topup process, Pin entry process. make sure these works flawlessly, DO not make Mistakes.